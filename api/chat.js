/**
 * CONTÁBIL INTELIGENTE — API Handler com Streaming + Arquitetura Híbrida
 * Arquivo: api/chat.js
 *
 * Fluxo:
 *  1. IA extrai dados estruturados em JSON
 *  2. api/regras.js faz os cálculos (nunca a IA)
 *  3. CNPJ extraído → consulta ReceitaWS → regime injetado automaticamente
 *  4. Resultado injetado na resposta final via streaming
 */

import {
  calcularExtrato,
  calcularRetencoes,
  validarJsonExtrato,
  formatarMoeda,
  verificarGatilhoUpsell,
  calcularTaxaSucesso,
  percentualTaxaSucesso,
} from './regras.js';

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// CONSULTA CNPJ — ReceitaWS
// ─────────────────────────────────────────────

/**
 * Extrai o primeiro CNPJ válido encontrado em um texto
 * @param {string} texto
 * @returns {string|null} CNPJ com 14 dígitos ou null
 */
function extrairCNPJ(texto) {
  if (!texto) return null;
  // Remove formatação e busca sequência de 14 dígitos após remoção de . - /
  const semFormato = texto.replace(/[.\-\/]/g, ' ');
  const matches = semFormato.match(/\b\d{14}\b/g);
  if (!matches) {
    // Tenta formato mascarado: XX.XXX.XXX/XXXX-XX
    const mascara = texto.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g);
    if (!mascara) return null;
    return mascara[0].replace(/[.\-\/]/g, '');
  }
  return matches[0];
}

/**
 * Mapeia o código de natureza jurídica/porte para regime tributário provável
 */
function inferirRegime(dados) {
  const porte = (dados.porte || '').toUpperCase();
  const natureza = (dados.natureza_juridica || '').toUpperCase();
  const situacao = (dados.situacao || '').toUpperCase();

  if (situacao !== 'ATIVA') return 'desconhecido';

  // MEI tem natureza jurídica específica (213-5)
  if (natureza.includes('213-5') || natureza.includes('MEI') || porte === 'MEI') return 'mei';

  // Simples Nacional por porte (ME ou EPP geralmente optam)
  if (porte === 'ME' || porte === 'EPP') return 'simples';

  // Demais portes: presumido como padrão conservador
  return 'presumido';
}

/**
 * Consulta ReceitaWS e retorna dados da empresa
 * @param {string} cnpj — 14 dígitos sem formatação
 * @returns {object|null}
 */
async function consultarCNPJ(cnpj) {
  if (!cnpj || cnpj.length !== 14) return null;

  try {
    const url = `https://receitaws.com.br/v1/cnpj/${cnpj}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000) // timeout 5s para não travar o fluxo
    });

    if (!resp.ok) return null;

    const dados = await resp.json();

    if (dados.status === 'ERROR') return null;

    const regime = inferirRegime(dados);

    return {
      cnpj: cnpj,
      cnpj_formatado: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
      razao_social: dados.nome || null,
      nome_fantasia: dados.fantasia || null,
      situacao: dados.situacao || null,
      porte: dados.porte || null,
      natureza_juridica: dados.natureza_juridica || null,
      municipio: dados.municipio || null,
      uf: dados.uf || null,
      regime_inferido: regime,
      data_abertura: dados.abertura || null,
      atividade_principal: dados.atividade_principal?.[0]?.text || null,
    };
  } catch (e) {
    // Timeout ou erro de rede — não bloqueia o fluxo principal
    return null;
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT — MODO EXTRAÇÃO JSON
// ─────────────────────────────────────────────

const SYSTEM_PROMPT_JSON = `Voce e o motor de extracao estruturada do Contabil Inteligente.

Quando o usuario enviar um documento (extrato bancario, NF-e, NFS-e, CT-e, laudo de solo ou boleto),
voce deve retornar APENAS um objeto JSON valido, sem texto antes ou depois, sem markdown, sem backticks.

=== FORMATO PARA EXTRATO BANCARIO ===
{
  "tipo_documento": "extrato_bancario",
  "banco": "nome do banco",
  "titular": "nome ou razao social",
  "periodo": "MM/AAAA ou data inicial - data final",
  "regime": "mei | simples | presumido | real | desconhecido",
  "cnpj_cpf": "numero se identificavel ou null",
  "transacoes": [
    {
      "data": "DD/MM/AAAA",
      "descricao": "descricao original da linha",
      "valor": 1500.00,
      "tipo": "entrada | saida | saldo"
    }
  ]
}

=== FORMATO PARA NFS-e / NF-e ===
{
  "tipo_documento": "nfse",
  "numero": "numero da nota",
  "emissor": "nome ou razao social",
  "cnpj_emissor": "00.000.000/0001-00 ou null",
  "tomador": "nome do tomador ou null",
  "cnpj_tomador": "00.000.000/0001-00 ou null",
  "regime": "mei | simples | presumido | real | desconhecido",
  "valor_bruto": 5000.00,
  "descricao_servico": "descricao",
  "competencia": "MM/AAAA",
  "retencoes_informadas": {
    "irrf": 0,
    "iss": 0,
    "pis": 0,
    "cofins": 0,
    "csll": 0
  }
}

=== FORMATO PARA LAUDO DE SOLO ===
{
  "tipo_documento": "laudo_solo",
  "laboratorio": "nome ou null",
  "data_coleta": "DD/MM/AAAA ou null",
  "cultura_alvo": "soja | milho | algodao | pastagem | outro | null",
  "parametros": [
    {
      "nome": "pH",
      "valor": 5.8,
      "unidade": "CaCl2",
      "tipo": "entrada"
    }
  ]
}

=== REGRAS OBRIGATORIAS DE EXTRACAO ===
1. Extraia TODAS as linhas do extrato — nenhuma pode ser omitida
2. Saldo inicial, saldo final, saldo do dia: tipo = "saldo" (nunca "entrada" ou "saida")
3. MEI: se identificado, regime = "mei"
4. Se o regime nao for identificavel, regime = "desconhecido"
5. Valores negativos mantidos como negativos no campo valor
6. Retorne SOMENTE o JSON — sem explicacoes, sem markdown`;

// ─────────────────────────────────────────────
// SYSTEM PROMPT — MODO CONSULTORIA
// ─────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `Voce e o Copiloto Empresarial da Contabil Inteligente, especialista em Contabilidade, Gestao Financeira, Fiscalidade Brasileira e Agronomia, com foco no mercado de Mato Grosso.

=== PERFIS E PLANOS ===

PLANO BASICO (R$ 197/mes) — BPO Financeiro, PF, MEI e Tecnico Agricola:
- Analisa extratos bancarios e laudos de solo
- Responde duvidas sobre MEI, IR, DAS e conciliacao bancaria
- NAO analisa NF-e, NFS-e, CT-e
- NAO identifica creditos tributarios de ICMS/PIS/COFINS
- NAO gera relatorio mensal fiscal

PLANO PLUS (R$ 379/mes) — PJ, Fiscal, Financeiro e Contabil:
- Analisa NF-e, NFS-e, CT-e, extratos e laudos de solo
- Identifica creditos de ICMS, PIS e COFINS nao aproveitados
- Aponta riscos fiscais e erros de classificacao
- Calcula retencoes por regime (Simples, Presumido, Real)
- Responde duvidas sobre MEI, IR, DAS e conciliacao
- Gera relatorio mensal automatico de economia identificada
- Atende todos os setores: agronegocio, comercio, servicos

=== QUANDO RECEBER RESULTADOS DE CALCULO ===

O backend ja calculou os totais com precisao. Voce vai receber um bloco como:

[RESULTADO_CALCULO]
{ ...json com totais calculados... }
[/RESULTADO_CALCULO]

Ao receber esse bloco:
1. NAO refaca os calculos — use os valores exatos do JSON
2. Apresente os resultados em tabela formatada
3. Adicione analise, alertas fiscais e recomendacoes
4. Siga o protocolo de 4 etapas na narrativa

=== QUANDO RECEBER DADOS DE CNPJ ===

Voce vai receber um bloco como:

[DADOS_CNPJ]
{ ...json com dados da empresa... }
[/DADOS_CNPJ]

Ao receber esse bloco:
1. Use o regime_inferido como base para calculos de retencao
2. Mencione a razao social e porte na analise
3. Se regime = "mei", aplique automaticamente as regras MEI (sem retencao ISS, PIS, COFINS, CSLL)
4. Se situacao != "ATIVA", alerte o cliente

=== PROTOCOLO OBRIGATORIO DE ANALISE ===

ETAPA 1 - IDENTIFICACAO DO DOCUMENTO
- Tipo, banco/emissor, periodo, titular (PF ou PJ, MEI ou nao), regime tributario

ETAPA 2 - INVENTARIO COMPLETO
- Confirme a quantidade total de transacoes processadas

ETAPA 3 - CLASSIFICACAO
Para EXTRATOS:
- ENTRADA REAL: PIX recebido, TED, deposito, credito de servico
- SAIDA REAL: PIX enviado, pagamento, debito, saque, tarifa
- IGNORADO (saldo): saldo inicial, saldo final, saldo do dia, limite disponivel
- MEI com conta PF: separar receitas MEI de entradas pessoais

Para NF-e / NFS-e (PLUS):
- Extrair numero, CNPJ, valores, impostos, retencoes, valor liquido

Para LAUDOS DE SOLO:
- Extrair todos os parametros, comparar com faixas de referencia

ETAPA 4 - RESULTADOS E RECOMENDACOES
- Use os valores calculados pelo backend
- Apresente em tabela
- Adicione alertas e proximos passos

=== SUPORTE AO TECNICO AGRICOLA ===

Quando o usuario for tecnico agricola ou enviar laudo de solo, atue como consultor agronomico:

ANALISE DE LAUDO DE SOLO:
1. Identifique a cultura alvo (soja, milho, algodao, pastagem, etc)
2. Extraia TODOS os parametros: pH, MO, P, K, Ca, Mg, S, micronutrientes, CTC, V%, argila
3. Para cada parametro: valor, faixa ideal, classificacao DEFICIENTE/ADEQUADO/ALTO/MUITO ALTO, impacto
4. Recomendacoes: calcario, gessagem, NPK por ha, micronutrientes, custo por hectare
5. Comparacao com medias de MT (fonte: EMBRAPA/IMEA)

=== DIAGNOSTICOS (PLANO PLUS) ===
FISCAL: regime tributario, retencoes, alertas fiscais BAIXO/MEDIO/ALTO
FINANCEIRO: tabela entradas/saidas/resultado, saldo informativo
CONTABIL: lancamentos, plano de contas, competencia vs caixa

=== REGRAS POR REGIME (PLANO PLUS) ===
- MEI / SIMPLES: limite R$ 81.000/ano, DAS mensal, sem retencao PIS/COFINS/CSLL
- LUCRO PRESUMIDO: IRRF 1-1,5% + CSRF 4,65% quando aplicavel
- LUCRO REAL: todas retencoes, credito PIS 1,65% COFINS 7,6%

=== MODO CONSULTORIA ===
Para perguntas sem documento: resposta didatica e objetiva.

=== FORMATO DE RESPOSTA ===
Comece com: Acao Imediata: [frase com a acao mais urgente]
Use tabelas para valores e indices.
Cite sempre a fonte (EMBRAPA, IMEA, legislacao).
TOM: Tecnico mas acessivel. Direto. Educativo.

FONTES: EMBRAPA, IMEA, MAPA, SENAR, CREA-MT, legislacao federal, RICMS-MT, ISS Cuiaba, LC 123/06, CGSN 140/2018.`;

// ─────────────────────────────────────────────
// DETECÇÃO DE DOCUMENTO
// ─────────────────────────────────────────────

function contemDocumento(messages) {
  const ultimaMensagem = [...messages].reverse().find(m => m.role === 'user');
  if (!ultimaMensagem || !Array.isArray(ultimaMensagem.content)) return false;
  return ultimaMensagem.content.some(c => c.type === 'image' || c.type === 'document');
}

// ─────────────────────────────────────────────
// EXTRAÇÃO JSON VIA IA (FASE 1)
// ─────────────────────────────────────────────

async function extrairJSON(messages, apiKey) {
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
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT_JSON,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Erro na extração JSON');
  }

  const data = await response.json();
  const texto = data.content?.find(c => c.type === 'text')?.text || '';
  const limpo = texto.replace(/```json|```/gi, '').trim();

  try {
    return JSON.parse(limpo);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// CÁLCULO NO BACKEND (FASE 2)
// ─────────────────────────────────────────────

function processarJSON(json, planoAtual = 'basico') {
  if (!json || !json.tipo_documento) return null;

  switch (json.tipo_documento) {
    case 'extrato_bancario': {
      const validacao = validarJsonExtrato(json);
      if (!validacao.valido) return { erro: validacao.erros.join('; ') };
      const resultado = calcularExtrato(json.transacoes, json.regime);
      const economia = parseFloat(json.economia_fiscal_identificada) || 0;
      const upsell = verificarGatilhoUpsell(resultado, planoAtual, economia);
      return {
        tipo: 'extrato_bancario', meta: json, ...resultado,
        economiaIdentificada: economia,
        taxaSucesso: calcularTaxaSucesso(economia),
        percentualTaxa: percentualTaxaSucesso(economia),
        upsell,
      };
    }
    case 'nfse':
    case 'nfe': {
      const retencoes = calcularRetencoes({
        valorBruto: json.valor_bruto,
        regime: json.regime,
        tipoServico: json.descricao_servico
      });
      const economia = parseFloat(json.economia_fiscal_identificada) || 0;
      return {
        tipo: json.tipo_documento, meta: json, ...retencoes,
        economiaIdentificada: economia,
        taxaSucesso: calcularTaxaSucesso(economia),
        percentualTaxa: percentualTaxaSucesso(economia),
        upsell: verificarGatilhoUpsell(null, planoAtual, economia),
      };
    }
    case 'laudo_solo': {
      return { tipo: 'laudo_solo', meta: json, parametros: json.parametros };
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// RESPOSTA FINAL VIA STREAMING (FASE 3)
// ─────────────────────────────────────────────

async function responderComResultados(messages, resultadoCalculo, dadosCNPJ, contextoMemoria, apiKey) {
  const mensagensComResultado = [...messages];
  const ultimoIdx = [...mensagensComResultado].map(m => m.role).lastIndexOf('user');

  if (ultimoIdx >= 0) {
    const ultima = mensagensComResultado[ultimoIdx];
    let injecao = '';

    if (resultadoCalculo) {
      injecao += `\n\n[RESULTADO_CALCULO]\n${JSON.stringify(resultadoCalculo, null, 2)}\n[/RESULTADO_CALCULO]`;
    }

    if (dadosCNPJ) {
      injecao += `\n\n[DADOS_CNPJ]\n${JSON.stringify(dadosCNPJ, null, 2)}\n[/DADOS_CNPJ]`;
    }

    if (injecao) {
      if (typeof ultima.content === 'string') {
        mensagensComResultado[ultimoIdx] = { ...ultima, content: ultima.content + injecao };
      } else if (Array.isArray(ultima.content)) {
        const novosItens = [...ultima.content];
        const idxTexto = novosItens.findLastIndex(c => c.type === 'text');
        if (idxTexto >= 0) {
          novosItens[idxTexto] = { ...novosItens[idxTexto], text: novosItens[idxTexto].text + injecao };
        } else {
          novosItens.push({ type: 'text', text: injecao });
        }
        mensagensComResultado[ultimoIdx] = { ...ultima, content: novosItens };
      }
    }
  }

  const systemPrompt = contextoMemoria && contextoMemoria.trim().length > 0
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
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: mensagensComResultado
    })
  });
}

// ─────────────────────────────────────────────
// NORMALIZAÇÃO DE MENSAGENS
// ─────────────────────────────────────────────

function normalizarMensagens(messages) {
  const normalizadas = messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      const hasMedia = msg.content.some(c => c.type === 'image' || c.type === 'document');
      if (!hasMedia) {
        const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        return { role: msg.role, content: textParts };
      }
    }
    return msg;
  });

  const deduplicadas = [];
  for (const msg of normalizadas) {
    if (deduplicadas.length === 0 || deduplicadas[deduplicadas.length - 1].role !== msg.role) {
      deduplicadas.push(msg);
    } else {
      const last = deduplicadas[deduplicadas.length - 1];
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n' + msg.content;
      }
    }
  }

  return deduplicadas;
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!verificarRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas requisicoes. Aguarde 1 minuto.' });
  }

  let { messages, contextoMemoria, planoAtual } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Requisicao invalida.' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Conversa muito longa. Inicie uma nova sessao.' });
  }

  messages = normalizarMensagens(messages);

  if (messages.length === 0 || messages[0].role !== 'user') {
    return res.status(400).json({ error: 'Mensagem invalida.' });
  }

  const apiKey = process.env.ANTHROPIC_KEY;

  try {
    let resultadoCalculo = null;
    let dadosCNPJ = null;

    if (contemDocumento(messages)) {
      // Fase 1: extração JSON pela IA
      const jsonExtraido = await extrairJSON(messages, apiKey);

      if (jsonExtraido) {
        // Fase 2a: cálculos pelo backend
        resultadoCalculo = processarJSON(jsonExtraido, planoAtual || 'basico');

        // Fase 2b: CNPJ automático — busca em paralelo sem bloquear
        const cnpjBruto =
          jsonExtraido.cnpj_cpf ||
          jsonExtraido.cnpj_emissor ||
          jsonExtraido.cnpj_tomador ||
          null;

        const cnpjLimpo = cnpjBruto
          ? extrairCNPJ(String(cnpjBruto))
          : null;

        if (cnpjLimpo) {
          dadosCNPJ = await consultarCNPJ(cnpjLimpo);

          // Se a ReceitaWS confirmou o regime, atualiza os cálculos
          if (dadosCNPJ && dadosCNPJ.regime_inferido !== 'desconhecido') {
            if (resultadoCalculo && resultadoCalculo.tipo === 'extrato_bancario' && jsonExtraido.regime === 'desconhecido') {
              resultadoCalculo = processarJSON({
                ...jsonExtraido,
                regime: dadosCNPJ.regime_inferido
              }, planoAtual || 'basico');
            }
          }
        }
      }
    }

    // Fase 3: resposta final com streaming
    const anthropicResponse = await responderComResultados(
      messages,
      resultadoCalculo,
      dadosCNPJ,
      contextoMemoria,
      apiKey
    );

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.json();
      return res.status(400).json({ error: err.error?.message || 'Erro na API.' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Envia card de resultado calculado
    if (resultadoCalculo && !resultadoCalculo.erro) {
      res.write(`data: ${JSON.stringify({ tipo: 'resultado_calculo', dados: resultadoCalculo })}\n\n`);
    }

    // Envia card de CNPJ (independente do resultado)
    if (dadosCNPJ) {
      res.write(`data: ${JSON.stringify({ tipo: 'dados_cnpj', dados: dadosCNPJ })}\n\n`);
    }

    // Streaming de texto
    const reader = anthropicResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
            }
            if (parsed.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch(e) {}
        }
      }
    }

    res.end();

  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    }
    res.end();
  }
}
