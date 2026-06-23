/**
 * CONTÁBIL INTELIGENTE — API Handler
 * Arquivo: api/chat.js
 */

import {
  calcularExtrato,
  calcularRetencoes,
  validarJsonExtrato,
  formatarMoeda,
  calcularTaxaSucesso,
  percentualTaxaSucesso,
  normalizar,
  arredondar,
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
      signal: AbortSignal.timeout(4000) // reduzido de 5s para 4s
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
const SYSTEM_PROMPT_JSON = `Voce e um Auditor Fiscal Senior especializado em recuperacao de credito tributario de ICMS para empresas do Lucro Real e Lucro Presumido em Mato Grosso.

Sua unica funcao e analisar visualmente os documentos enviados (NF-e, NFS-e, CT-e, SPED Fiscal, DANFE) e retornar estritamente um objeto JSON estruturado.

=== DIRETRIZES OBRIGATORIAS ===
- Saida: APENAS o objeto JSON. Zero texto, zero markdown.
- Extracao Fiel: valores numericos exatos do documento, convertidos para Float.
- PROIBIDO calcular somas, percentuais ou arredondamentos — extraia valores brutos por linha.
- Extraia TODOS os itens — nenhum omitido.
- NUNCA cite Anexos do Simples Nacional para Lucro Presumido ou Real.

=== SCHEMA JSON ===
{
  "tipo_documento": "nfe | nfse | cte | sped_efd | danfe | extrato_bancario | outro",
  "periodo_competencia": "AAAA-MM ou null",
  "empresa_identificada": {
    "cnpj": "string ou null",
    "razao_social": "string ou null",
    "uf": "MT ou outra UF ou null",
    "regime_tributario_identificado": "Lucro Presumido | Lucro Real | Simples Nacional | MEI | null"
  },
  "alertas_fiscais_preliminares": [
    {
      "nivel": "ALTO | MEDIO | BAIXO",
      "mensagem": "descricao com base legal obrigatoria — ex: CST 60 sem ressarcimento (Art. 457 RICMS-MT)"
    }
  ],
  "itens_auditados": [
    {
      "id": 1,
      "data": "AAAA-MM-DD ou null",
      "descricao": "descricao literal do item",
      "cfop": "string 4 digitos ou null",
      "cst_icms": "string ou null",
      "ncm": "string ou null",
      "valor_contabil": 0.00,
      "base_calculo_icms": 0.00,
      "valor_icms_destacado": 0.00,
      "credito_elegivel": true,
      "tributo_alvo": "ICMS | ICMS_ST | DIFAL | CIAP | NONE",
      "justificativa_fiscal": "base legal obrigatoria — ex: Art. 20 LC 87/96 + Art. 113 RICMS-MT"
    }
  ],
  "economia_fiscal_identificada": 0.00
}

=== MATRIZ DE ELEGIBILIDADE ===
1. ICMS INSUMOS: CFOPs 1.101,1.102,1.111,1.113,2.101,2.102,2.111,2.113 | CST 00,10,20,70 | Base: Art. 20 LC 87/96 + Art. 113 RICMS-MT
2. ICMS-ST: CST 60 / CSOSN 500 / CFOPs 1.401,1.403,1.407,1.411,2.401,2.403,2.407,2.411 | Base: Art. 457 RICMS-MT + Anexo X
3. DIFAL: operacoes interestaduais com DIFAL pago a maior | Base: Art. 155 §2 VIII CF/88
4. CIAP: CFOPs 1.551,1.406,2.551 | 1/48 avos mensais | Base: Art. 20 §5 LC 87/96 + Arts. 400-406 RICMS-MT
5. FRETE: CFOPs 1.352,2.352 | Base: Art. 20 LC 87/96

=== REGRAS ESPECIAIS ===
- Simples Nacional / MEI: nao geram credito ICMS para destinatario (NONE)
- CST ausente: preencher null
- ICMS nao destacado graficamente: valor_icms_destacado = 0.00
- economia_fiscal_identificada: sempre 0.00 (backend calcula)`;

// ── SYSTEM PROMPT LAUDO — FORMATO CURTO E DIRETO ──
const SYSTEM_PROMPT_BASE = `Voce e o CI — Auditor Fiscal Senior da Contabil Inteligente.
Foco: recuperacao de credito ICMS para Lucro Real e Lucro Presumido em Mato Grosso.

=== FORMATO DO LAUDO — OBRIGATORIO ===
Laudo CURTO e DIRETO. Maximo 400 palavras. Sem repeticoes. Sem introducoes longas.
Tom tecnico — voce fala com contadores e auditores fiscais experientes.

ESTRUTURA OBRIGATORIA (nesta ordem):

**EMPRESA**
Razao Social | CNPJ | Regime | Periodo

**CREDITOS IDENTIFICADOS**
Tabela com colunas: Tipo | CFOP | CST | Base de Calculo | ICMS | Base Legal
Uma linha por credito elegivel.
Se nao houver creditos: "Nenhum credito de ICMS elegivel neste documento — [motivo com base legal]"

**COMO CHEGAMOS A ESSES VALORES**
Para cada tipo de credito, explicar em 1-2 linhas:
- Qual regra foi aplicada (artigo + lei)
- O calculo: Base R$ X x Aliquota Y% = ICMS R$ Z
Exemplo: "ICMS sobre insumos: BC R$ 5.000,00 x 17% (Art. 95 I RICMS-MT) = R$ 850,00 — elegivel conforme Art. 20 LC 87/96 e Art. 113 RICMS-MT"

**ALERTAS**
Para cada alerta, formato obrigatorio:
[COR] NIVEL — Titulo curto
Descricao objetiva em 1-2 linhas com base legal.
Base legal: [artigo + lei/decreto]

Cores e criterios:
🔴 ALTO: credito negado, ST indevida, DIFAL a maior, CIAP nao escriturado — exige acao imediata
🟡 MEDIO: CFOP incorreto, CST divergente, aproveitamento parcial — monitorar
🟢 BAIXO: oportunidade de revisao historica, divergencia cadastral — acompanhar

**ACAO IMEDIATA**
Uma frase: o que fazer agora, com prazo e base legal.

=== BASE LEGAL OBRIGATORIA ===
- ICMS insumos: Art. 20 LC 87/96 (Lei Kandir) + Art. 113 RICMS-MT
- ICMS-ST: Art. 457 RICMS-MT + Arts. 9-12 Anexo X RICMS-MT
- DIFAL: Art. 155 §2 VIII CF/88
- CIAP: Art. 20 §5 LC 87/96 + Arts. 400-406 RICMS-MT
- Frete: Art. 20 LC 87/96 | CFOPs 1.352/2.352
- Prescricao: Art. 168 CTN (5 anos)
- Aliquota interna MT: 17% (Art. 95 I alinea a RICMS-MT)

=== COMPLIANCE ===
- NUNCA use DAS para Lucro Presumido/Real (usar DARF)
- NUNCA cite Anexos do Simples para Lucro Presumido/Real
- Calculos: use APENAS os valores do [RESULTADO_CALCULO] — nunca recalcule`;

// ── DETECÇÃO DE DOCUMENTO ──
function contemDocumento(messages) {
  const ultima = [...messages].reverse().find(m => m.role === 'user');
  if (!ultima || !Array.isArray(ultima.content)) return false;
  return ultima.content.some(c => c.type === 'image' || c.type === 'document');
}

// ── CACHE NO DOCUMENTO ──
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

// ── EXTRAÇÃO JSON (FASE 1) ──
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
function processarJSON(json, planoAtual = 'ultra') {
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
    case 'nfe': case 'nfse': case 'cte': case 'sped_efd': case 'danfe': {
      const itens = json.itens_auditados || [];
      const creditosElegiveis = itens.filter(i => i.credito_elegivel === true);
      const totalCreditoICMS = creditosElegiveis
        .filter(i => i.tributo_alvo === 'ICMS' || i.tributo_alvo === 'AMBOS')
        .reduce((s, i) => s + (parseFloat(i.valor_icms_destacado) || 0), 0);
      const totalCreditoST = creditosElegiveis
        .filter(i => i.tributo_alvo === 'ICMS_ST')
        .reduce((s, i) => s + (parseFloat(i.valor_icms_destacado) || 0), 0);
      const totalCreditoDIFAL = creditosElegiveis
        .filter(i => i.tributo_alvo === 'DIFAL')
        .reduce((s, i) => s + (parseFloat(i.valor_icms_destacado) || 0), 0);
      const totalCreditoCIAP = creditosElegiveis
        .filter(i => i.tributo_alvo === 'CIAP')
        .reduce((s, i) => s + (parseFloat(i.valor_icms_destacado) || 0), 0);
      const totalGeralCreditos = arredondar(
        totalCreditoICMS + totalCreditoST + totalCreditoDIFAL + totalCreditoCIAP
      );
      // Backend JS tem palavra final
      const economiaFinal = totalGeralCreditos;
      return {
        tipo: json.tipo_documento,
        meta: { ...json, cnpj_emissor: cnpj, regime, alertas_fiscais: alertasFiscais },
        itensAuditados: itens,
        creditosElegiveis,
        totalCreditoICMS:   arredondar(totalCreditoICMS),
        totalCreditoST:     arredondar(totalCreditoST),
        totalCreditoDIFAL:  arredondar(totalCreditoDIFAL),
        totalCreditoCIAP:   arredondar(totalCreditoCIAP),
        totalGeralCreditos,
        economiaIdentificada: economiaFinal,
        taxaSucesso:    calcularTaxaSucesso(economiaFinal),
        percentualTaxa: percentualTaxaSucesso(economiaFinal),
        upsell: { exibir: false },
      };
    }

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
      return {
        tipo: 'extrato_bancario', meta: jsonNormalizado, ...resultado,
        economiaIdentificada: economia,
        taxaSucesso: calcularTaxaSucesso(economia),
        percentualTaxa: percentualTaxaSucesso(economia),
        upsell: { exibir: false },
      };
    }

    default:
      return null;
  }
}

// ── RESPOSTA FINAL COM STREAMING (FASE 3) ──
async function responderComResultados(messages, resultadoCalculo, dadosCNPJ, contextoMemoria, apiKey) {
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
      max_tokens: 1500, // reduzido de 4096 para forçar laudo curto
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
      // ── PARALELISMO: extração JSON + consulta CNPJ simultâneas ──
      // Fase 1: extrai JSON do documento
      const jsonExtraido = await extrairJSON(messages, apiKey);

      if (jsonExtraido) {
        // Fase 2: cálculo JS (síncrono, instantâneo)
        resultadoCalculo = processarJSON(jsonExtraido, planoAtual || 'ultra');

        // Extrai CNPJ do JSON para consulta
        const cnpjBruto = jsonExtraido.empresa_identificada?.cnpj ||
          jsonExtraido.cnpj_cpf || jsonExtraido.cnpj_emissor || jsonExtraido.cnpj_tomador || null;
        const cnpjLimpo = cnpjBruto ? extrairCNPJ(String(cnpjBruto)) : null;

        // ── PARALELO: consulta CNPJ + monta resposta simultaneamente ──
        // consultarCNPJ roda em paralelo com o início da Fase 3
        const [cnpjResult] = await Promise.all([
          cnpjLimpo ? consultarCNPJ(cnpjLimpo) : Promise.resolve(null),
        ]);

        dadosCNPJ = cnpjResult;

        // Refina regime se CNPJ trouxe info mais precisa
        if (dadosCNPJ?.regime_inferido && dadosCNPJ.regime_inferido !== 'desconhecido') {
          const regimeAtual = jsonExtraido.empresa_identificada?.regime_tributario_identificado || jsonExtraido.regime || '';
          if (!regimeAtual || normalizar(regimeAtual) === 'desconhecido') {
            resultadoCalculo = processarJSON({ ...jsonExtraido, regime: dadosCNPJ.regime_inferido }, planoAtual || 'ultra');
          }
        }
      }
    }

    // Fase 3: laudo streaming — inicia IMEDIATAMENTE após Fase 1+2
    const anthropicResponse = await responderComResultados(messages, resultadoCalculo, dadosCNPJ, contextoMemoria, apiKey);

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.json().catch(() => ({}));
      return res.status(400).json({ error: err.error?.message || 'Erro na API.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Envia dados calculados ANTES do streaming de texto
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
