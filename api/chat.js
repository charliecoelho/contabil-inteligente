/**
 * CONTÁBIL INTELIGENTE — API Handler
 * Arquivo: api/chat.js
 */

import {
  calcularExtrato,
  calcularRetencoes,
  validarJsonExtrato,
  formatarMoeda,
  verificarGatilhoUpsell,
  calcularTaxaSucesso,
  percentualTaxaSucesso,
  normalizar,
} from './regras.js';

// ── RATE LIMITING ──
const rateLimitMap = new Map();
const LIMITE_POR_MINUTO = 15;
const JANELA_MS = 60 * 1000;

function verificarRateLimit(ip) {
  const agora = Date.now();
  const registro = rateLimitMap.get(ip) || { count: 0, inicio: agora };
  if (agora - registro.inicio > JANELA_MS) { registro.count = 0; registro.inicio = agora; }
  registro.count++;
  rateLimitMap.set(ip, registro);
  if (rateLimitMap.size > 200) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (agora - val.inicio > JANELA_MS * 2) rateLimitMap.delete(key);
    }
  }
  return registro.count <= LIMITE_POR_MINUTO;
}

// ── CNPJ ──
function extrairCNPJ(texto) {
  if (!texto) return null;
  const semFormato = texto.replace(/[.\-\/]/g, ' ');
  const matches = semFormato.match(/\b\d{14}\b/g);
  if (!matches) {
    const mascara = texto.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g);
    if (!mascara) return null;
    return mascara[0].replace(/[.\-\/]/g, '');
  }
  return matches[0];
}

function inferirRegime(dados) {
  const porte = (dados.porte || '').toUpperCase();
  const natureza = (dados.natureza_juridica || '').toUpperCase();
  const situacao = (dados.situacao || '').toUpperCase();
  if (situacao !== 'ATIVA') return 'desconhecido';
  if (natureza.includes('213-5') || natureza.includes('MEI') || porte === 'MEI') return 'mei';
  if (porte === 'ME' || porte === 'EPP') return 'simples';
  return 'presumido';
}

async function consultarCNPJ(cnpj) {
  if (!cnpj || cnpj.length !== 14) return null;
  try {
    const resp = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const dados = await resp.json();
    if (dados.status === 'ERROR') return null;
    return {
      cnpj,
      cnpj_formatado: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
      razao_social: dados.nome || null,
      nome_fantasia: dados.fantasia || null,
      situacao: dados.situacao || null,
      porte: dados.porte || null,
      natureza_juridica: dados.natureza_juridica || null,
      municipio: dados.municipio || null,
      uf: dados.uf || null,
      regime_inferido: inferirRegime(dados),
      data_abertura: dados.abertura || null,
      atividade_principal: dados.atividade_principal?.[0]?.text || null,
    };
  } catch (e) { return null; }
}

// ── SYSTEM PROMPT EXTRAÇÃO JSON ──
const SYSTEM_PROMPT_JSON = `Voce e um extrator multimodal de dados fiscais e financeiros para o mercado brasileiro. Sua unica funcao e analisar visualmente os documentos enviados (PDFs/Imagens) e retornar estritamente um objeto JSON estruturado.

=== DIRETRIZES TECNICAS OBRIGATORIAS ===
- Saida: Responda APENAS com o objeto JSON. Nao inclua textos introdutorios, explicacoes ou blocos de codigo markdown.
- Extracao Fiel: Capture os valores numericos exatamente como aparecem no documento. Transforme strings monetarias em numeros decimais puros (Float). Nao tente somar ou calcular saldos.
- Extraia TODAS as linhas/transacoes do documento — nenhuma pode ser omitida.

=== SCHEMA JSON REQUERIDO ===
{
  "tipo_documento": "extrato_bancario | nfe | nfse | cte | laudo_solo | boleto | outro",
  "banco": "Nubank | Inter | Bradesco | BB | Itau | outro_banco | null",
  "periodo": {
    "data_inicio": "AAAA-MM-DD ou null",
    "data_fim": "AAAA-MM-DD ou null"
  },
  "empresa_identificada": {
    "cnpj": "string ou null",
    "razao_social": "string ou null",
    "regime_tributario_identificado": "MEI | Simples Nacional | Lucro Presumido | Lucro Real | null"
  },
  "alertas_fiscais_preliminares": [
    {
      "nivel": "ALTO | MEDIO | BAIXO",
      "mensagem": "descricao da anomalia identificada"
    }
  ],
  "transacoes": [
    {
      "id": 1,
      "data": "AAAA-MM-DD",
      "descricao": "texto bruto da transacao ou item",
      "valor": 1500.00,
      "categoria": "entrada_real | saida_real | informativo"
    }
  ],
  "economia_fiscal_identificada": 0.00
}

=== REGRAS DE CATEGORIZACAO DAS TRANSACOES ===
- entrada_real: PIX recebido, TED recebida, deposito, credito de servico, receita, venda
- saida_real: PIX enviado, TED enviada, pagamento, debito, saque, tarifa, taxa, compra
- informativo: saldo inicial, saldo final, saldo do dia, limite disponivel, limite de credito (NUNCA somar)

=== REGRAS ESPECIAIS ===
- MEI: nunca classificar retencao de ISS como saida_real sobre o proprio MEI
- Valores negativos: manter como negativos no campo valor
- economia_fiscal_identificada: preencher com o valor em R$ de creditos tributarios ou economia identificada. Se nao houver, retornar 0.00`;

// ── SYSTEM PROMPT CONSULTORIA ──
const SYSTEM_PROMPT_BASE = `Voce e o Copiloto Empresarial da Contabil Inteligente, especialista em Contabilidade, Gestao Financeira, Fiscalidade Brasileira e Agronomia, com foco no mercado de Mato Grosso.

=== PERFIS E PLANOS ===
PLANO BASICO (R$ 197/mes) — BPO Financeiro, PF, MEI e Tecnico Agricola
PLANO PLUS (R$ 397/mes) — PJ, Fiscal, Financeiro e Contabil
PLANO ULTRA (R$ 797/mes) — Grandes Escritorios, Lucro Real

=== QUANDO RECEBER RESULTADOS DE CALCULO ===
O backend ja calculou os totais com precisao. Voce vai receber um bloco [RESULTADO_CALCULO]...[/RESULTADO_CALCULO].
1. NAO refaca os calculos — use os valores exatos do JSON
2. Apresente em tabela formatada
3. Adicione analise, alertas fiscais e recomendacoes

=== PROTOCOLO OBRIGATORIO DE ANALISE ===
ETAPA 1 - IDENTIFICACAO: tipo, banco/emissor, periodo, titular, regime
ETAPA 2 - INVENTARIO: confirme quantidade total de transacoes
ETAPA 3 - CLASSIFICACAO: entradas reais / saidas reais / saldos ignorados
ETAPA 4 - RESULTADOS: use valores calculados, apresente em tabela, adicione alertas

=== SUPORTE AO TECNICO AGRICOLA ===
Laudos de solo: pH, MO, P, K, Ca, Mg, S, micronutrientes, CTC, V%, argila.
Recomendacoes: calcario, gessagem, NPK, micronutrientes, custo por hectare.
Referencias: EMBRAPA, IMEA, MAPA para MT.

=== REGRAS POR REGIME ===
- MEI / SIMPLES: limite R$ 81.000/ano, DAS mensal, sem retencao PIS/COFINS/CSLL
- LUCRO PRESUMIDO: IRRF 1-1,5% + CSRF 4,65% quando aplicavel
- LUCRO REAL: todas retencoes, credito PIS 1,65% COFINS 7,6%

=== FORMATO DE RESPOSTA ===
Comece com: Acao Imediata: [frase com a acao mais urgente]
Use tabelas para valores. Cite a fonte (EMBRAPA, IMEA, legislacao).
TOM: Tecnico mas acessivel. Direto. Educativo.
FONTES: EMBRAPA, IMEA, MAPA, SENAR, CREA-MT, LC 123/06, CGSN 140/2018, RICMS-MT.`;

// ── DETECÇÃO DE DOCUMENTO ──
function contemDocumento(messages) {
  const ultima = [...messages].reverse().find(m => m.role === 'user');
  if (!ultima || !Array.isArray(ultima.content)) return false;
  return ultima.content.some(c => c.type === 'image' || c.type === 'document');
}

// ── EXTRAÇÃO JSON (FASE 1) ──

/**
 * Injeta cache_control no primeiro documento/imagem da mensagem.
 * Permite que o PDF seja cacheado entre a Fase 1 e Fase 2,
 * reduzindo latência e custo da segunda chamada em até 90%.
 */
function adicionarCacheNoDocumento(messages) {
  const copia = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    let primeiroDocCacheado = false;
    const novoContent = msg.content.map(item => {
      if (!primeiroDocCacheado && (item.type === 'document' || item.type === 'image')) {
        primeiroDocCacheado = true;
        return { ...item, cache_control: { type: 'ephemeral' } };
      }
      return item;
    });
    return { ...msg, content: novoContent };
  });
  return copia;
}

async function extrairJSON(messages, apiKey) {
  const messagesComCache = adicionarCacheNoDocumento(messages);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT_JSON, cache_control: { type: 'ephemeral' } }],
      messages: messagesComCache
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const texto = data.content?.find(c => c.type === 'text')?.text || '';
  const limpo = texto.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(limpo); } catch { return null; }
}

// ── CÁLCULO NO BACKEND (FASE 2) ──
function processarJSON(json, planoAtual = 'basico') {
  if (!json || !json.tipo_documento) return null;

  const mapCategoria = (cat) => {
    if (cat === 'entrada_real') return 'entrada';
    if (cat === 'saida_real')   return 'saida';
    return 'saldo';
  };

  const cnpj = json.empresa_identificada?.cnpj || json.cnpj_cpf || json.cnpj_emissor || null;
  const regimeRaw = json.empresa_identificada?.regime_tributario_identificado || json.regime || 'desconhecido';
  const regime = (normalizar(regimeRaw || '')
    .replace('simples nacional', 'simples')
    .replace('lucro presumido', 'presumido')
    .replace('lucro real', 'real')) || 'desconhecido';

  const alertasFiscais = json.alertas_fiscais_preliminares || json.alertas_fiscais || [];
  const economia = parseFloat(json.economia_fiscal_identificada) || 0;

  switch (json.tipo_documento) {
    case 'extrato_bancario': {
      const transacoesNormalizadas = (json.transacoes || []).map((t, i) => ({
        ...t,
        id: t.id || i + 1,
        tipo: t.tipo || mapCategoria(t.categoria),
      }));
      const jsonNormalizado = { ...json, cnpj_cpf: cnpj, regime, alertas_fiscais: alertasFiscais, transacoes: transacoesNormalizadas };
      const validacao = validarJsonExtrato(jsonNormalizado);
      if (!validacao.valido) return { erro: validacao.erros.join('; ') };
      const resultado = calcularExtrato(transacoesNormalizadas, regime);
      const upsell = verificarGatilhoUpsell(resultado, planoAtual, economia);
      return {
        tipo: 'extrato_bancario', meta: jsonNormalizado, ...resultado,
        economiaIdentificada: economia,
        taxaSucesso: calcularTaxaSucesso(economia),
        percentualTaxa: percentualTaxaSucesso(economia),
        upsell,
      };
    }
    case 'nfe': case 'nfse': case 'cte': {
      const valorBruto = json.valor_bruto ||
        (json.transacoes || []).reduce((s, t) => s + Math.abs(parseFloat(t.valor) || 0), 0);
      const retencoes = calcularRetencoes({ valorBruto, regime, tipoServico: json.descricao_servico || json.tipo_documento });
      return {
        tipo: json.tipo_documento,
        meta: { ...json, cnpj_emissor: cnpj, regime, alertas_fiscais: alertasFiscais },
        ...retencoes,
        economiaIdentificada: economia,
        taxaSucesso: calcularTaxaSucesso(economia),
        percentualTaxa: percentualTaxaSucesso(economia),
        upsell: verificarGatilhoUpsell(null, planoAtual, economia),
      };
    }
    case 'laudo_solo':
      return { tipo: 'laudo_solo', meta: json, parametros: json.parametros || json.transacoes || [] };
    default:
      return null;
  }
}

// ── RESPOSTA FINAL COM STREAMING (FASE 3) ──
async function responderComResultados(messages, resultadoCalculo, dadosCNPJ, contextoMemoria, apiKey) {
  // Injeta cache no documento (reutiliza cache da Fase 1 — sem custo extra)
  let msgs = adicionarCacheNoDocumento([...messages]);
  const idx = [...msgs].map(m => m.role).lastIndexOf('user');

  if (idx >= 0) {
    let injecao = '';
    if (resultadoCalculo) injecao += `\n\n[RESULTADO_CALCULO]\n${JSON.stringify(resultadoCalculo, null, 2)}\n[/RESULTADO_CALCULO]`;
    if (dadosCNPJ)        injecao += `\n\n[DADOS_CNPJ]\n${JSON.stringify(dadosCNPJ, null, 2)}\n[/DADOS_CNPJ]`;

    if (injecao) {
      const ultima = msgs[idx];
      if (typeof ultima.content === 'string') {
        msgs[idx] = { ...ultima, content: ultima.content + injecao };
      } else if (Array.isArray(ultima.content)) {
        const itens = [...ultima.content];
        const ti = itens.findLastIndex(c => c.type === 'text');
        if (ti >= 0) itens[ti] = { ...itens[ti], text: itens[ti].text + injecao };
        else itens.push({ type: 'text', text: injecao });
        msgs[idx] = { ...ultima, content: itens };
      }
    }
  }

  const system = contextoMemoria?.trim()
    ? SYSTEM_PROMPT_BASE + '\n' + contextoMemoria
    : SYSTEM_PROMPT_BASE;

  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      stream: true,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: msgs
    })
  });
}

// ── NORMALIZAÇÃO DE MENSAGENS ──
function normalizarMensagens(messages) {
  const norm = messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      const hasMedia = msg.content.some(c => c.type === 'image' || c.type === 'document');
      if (!hasMedia) {
        const txt = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        return { role: msg.role, content: txt };
      }
    }
    return msg;
  });
  const dedup = [];
  for (const msg of norm) {
    if (!dedup.length || dedup[dedup.length - 1].role !== msg.role) {
      dedup.push(msg);
    } else {
      const last = dedup[dedup.length - 1];
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n' + msg.content;
      }
    }
  }
  return dedup;
}

// ── HANDLER PRINCIPAL ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Metodo nao permitido.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!verificarRateLimit(ip)) return res.status(429).json({ error: 'Muitas requisicoes. Aguarde 1 minuto.' });

  let { messages, contextoMemoria, planoAtual } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'Requisicao invalida.' });
  if (messages.length > 50)
    return res.status(400).json({ error: 'Conversa muito longa. Inicie uma nova sessao.' });

  messages = normalizarMensagens(messages);

  if (!messages.length || messages[0].role !== 'user')
    return res.status(400).json({ error: 'Mensagem invalida.' });

  const apiKey = process.env.ANTHROPIC_KEY;

  try {
    let resultadoCalculo = null;
    let dadosCNPJ = null;

    if (contemDocumento(messages)) {
      const jsonExtraido = await extrairJSON(messages, apiKey);

      if (jsonExtraido) {
        resultadoCalculo = processarJSON(jsonExtraido, planoAtual || 'basico');

        const cnpjBruto = jsonExtraido.empresa_identificada?.cnpj ||
          jsonExtraido.cnpj_cpf || jsonExtraido.cnpj_emissor || jsonExtraido.cnpj_tomador || null;
        const cnpjLimpo = cnpjBruto ? extrairCNPJ(String(cnpjBruto)) : null;

        if (cnpjLimpo) {
          dadosCNPJ = await consultarCNPJ(cnpjLimpo);
          if (dadosCNPJ?.regime_inferido && dadosCNPJ.regime_inferido !== 'desconhecido') {
            const regimeAtual = jsonExtraido.empresa_identificada?.regime_tributario_identificado || jsonExtraido.regime || '';
            if (!regimeAtual || normalizar(regimeAtual) === 'desconhecido') {
              resultadoCalculo = processarJSON({ ...jsonExtraido, regime: dadosCNPJ.regime_inferido }, planoAtual || 'basico');
            }
          }
        }
      }
    }

    const anthropicResponse = await responderComResultados(messages, resultadoCalculo, dadosCNPJ, contextoMemoria, apiKey);

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.json().catch(() => ({}));
      return res.status(400).json({ error: err.error?.message || 'Erro na API.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (resultadoCalculo && !resultadoCalculo.erro)
      res.write(`data: ${JSON.stringify({ tipo: 'resultado_calculo', dados: resultadoCalculo })}\n\n`);
    if (dadosCNPJ)
      res.write(`data: ${JSON.stringify({ tipo: 'dados_cnpj', dados: dadosCNPJ })}\n\n`);

    const reader = anthropicResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text)
            res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
          if (parsed.type === 'message_stop')
            res.write('data: [DONE]\n\n');
        } catch(e) {}
      }
    }

    res.end();

  } catch (error) {
    console.error('[ERRO]', error.message);
    if (!res.headersSent)
      return res.status(500).json({ error: error.message || 'Erro interno. Tente novamente.' });
    res.end();
  }
}
