/**
 * CONTÁBIL INTELIGENTE — API Handler com Streaming + Arquitetura Híbrida
 * Arquivo: api/chat.js
 *
 * Fluxo:
 *  1. IA extrai dados estruturados em JSON
 *  2. api/regras.js faz os cálculos (nunca a IA)
 *  3. Resultado injetado na resposta final via streaming
 */

import {
  calcularExtrato,
  calcularRetencoes,
  validarJsonExtrato,
  formatarMoeda,
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
// SYSTEM PROMPT — MODO EXTRAÇÃO JSON
// Usado quando há documento (extrato, NF, laudo)
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
// Usado para perguntas sem documento
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
4. Siga o protocolo de 4 etapas na narrativa (identificacao, inventario, classificacao, resultado)

=== PROTOCOLO OBRIGATORIO DE ANALISE ===

ETAPA 1 - IDENTIFICACAO DO DOCUMENTO
- Tipo, banco/emissor, periodo, titular (PF ou PJ, MEI ou nao), regime tributario

ETAPA 2 - INVENTARIO COMPLETO
- Confirme a quantidade total de transacoes processadas
- Para PDFs extensos: confirme que todas as paginas foram processadas

ETAPA 3 - CLASSIFICACAO
Para EXTRATOS:
- ENTRADA REAL: PIX recebido, TED, deposito, credito de servico
- SAIDA REAL: PIX enviado, pagamento, debito, saque, tarifa
- IGNORADO (saldo): saldo inicial, saldo final, saldo do dia, limite disponivel
- MEI com conta PF: separar receitas MEI de entradas pessoais

Para NF-e / NFS-e (PLUS):
- Extrair numero, CNPJ, valores, impostos, retencoes, valor liquido
- Nao confundir valor bruto com liquido

Para LAUDOS DE SOLO:
- Extrair todos os parametros analisados
- Comparar com faixas de referencia (ideal, baixo, alto)
- Identificar deficiencias e excessos

ETAPA 4 - RESULTADOS E RECOMENDACOES
- Use os valores calculados pelo backend
- Apresente em tabela
- Adicione alertas e proximos passos

=== SUPORTE AO TECNICO AGRICOLA ===

Quando o usuario for tecnico agricola ou enviar laudo de solo, atue como consultor agronomico:

ANALISE DE LAUDO DE SOLO:
1. Identifique a cultura alvo (soja, milho, algodao, pastagem, etc)
2. Extraia TODOS os parametros: pH, MO, P, K, Ca, Mg, S, micronutrientes, CTC, V%, argila
3. Para cada parametro, informe:
   - Valor encontrado
   - Faixa ideal para a cultura
   - Classificacao: DEFICIENTE / ADEQUADO / ALTO / MUITO ALTO
   - Impacto na producao se fora da faixa ideal
4. Recomendacoes de corretivos e fertilizantes:
   - Calcario: dose e PRNT recomendado
   - Gessagem: quando necessaria e dose
   - Adubacao de base: NPK por ha
   - Adubacao de cobertura: quando e quanto
   - Micronutrientes deficientes: produto e dose
5. Estimativa de custo da correcao por hectare
6. Comparacao com medias de MT (fonte: EMBRAPA/IMEA)

=== DIAGNOSTICOS (PLANO PLUS) ===

FISCAL: regime tributario, retencoes, alertas fiscais com nivel BAIXO/MEDIO/ALTO
FINANCEIRO: tabela de entradas/saidas/resultado, saldo informativo
CONTABIL: lancamentos, plano de contas, competencia vs caixa

=== REGRAS POR REGIME (PLANO PLUS) ===
- MEI / SIMPLES: limite R$ 81.000/ano, DAS mensal, sem retencao PIS/COFINS/CSLL
- LUCRO PRESUMIDO: IRRF 1-1,5% + CSRF 4,65% quando aplicavel
- LUCRO REAL: todas retencoes, credito PIS 1,65% COFINS 7,6%

=== MODO CONSULTORIA ===
Para perguntas sem documento:
- Responda de forma didatica e objetiva
- MEI: separacao PF/PJ, limites, DAS, IR
- Tecnico agricola: interpretacao, recomendacoes, calculos agronomicos
- Escritorios: fluxos e checklists

=== FORMATO DE RESPOSTA ===
Comece com: Acao Imediata: [frase com a acao mais urgente]
Use tabelas para valores e indices.
Cite sempre a fonte (EMBRAPA, IMEA, legislacao).
TOM: Tecnico mas acessivel. Direto. Educativo.

FONTES: EMBRAPA, IMEA, MAPA, SENAR, CREA-MT, legislacao federal, RICMS-MT, ISS Cuiaba, LC 123/06, CGSN 140/2018.`;

// ─────────────────────────────────────────────
// DETECÇÃO DE DOCUMENTO NA MENSAGEM
// ─────────────────────────────────────────────

/**
 * Verifica se a última mensagem do usuário contém um documento (imagem/PDF)
 */
function contemDocumento(messages) {
  const ultimaMensagem = [...messages].reverse().find(m => m.role === 'user');
  if (!ultimaMensagem || !Array.isArray(ultimaMensagem.content)) return false;
  return ultimaMensagem.content.some(c => c.type === 'image' || c.type === 'document');
}

// ─────────────────────────────────────────────
// EXTRAÇÃO JSON VIA IA (FASE 1)
// ─────────────────────────────────────────────

/**
 * Chama a IA no modo extração — retorna JSON estruturado
 */
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

  // Remove possíveis backticks residuais
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

/**
 * Aplica os guardrails e calcula os resultados a partir do JSON extraído
 */
function processarJSON(json) {
  if (!json || !json.tipo_documento) return null;

  switch (json.tipo_documento) {
    case 'extrato_bancario': {
      const validacao = validarJsonExtrato(json);
      if (!validacao.valido) return { erro: validacao.erros.join('; ') };
      const resultado = calcularExtrato(json.transacoes, json.regime);
      return { tipo: 'extrato_bancario', meta: json, ...resultado };
    }

    case 'nfse':
    case 'nfe': {
      const retencoes = calcularRetencoes({
        valorBruto: json.valor_bruto,
        regime: json.regime,
        tipoServico: json.descricao_servico
      });
      return { tipo: json.tipo_documento, meta: json, ...retencoes };
    }

    case 'laudo_solo': {
      // Laudos de solo: sem cálculo financeiro — retorna dados estruturados
      return { tipo: 'laudo_solo', meta: json, parametros: json.parametros };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// RESPOSTA FINAL VIA STREAMING (FASE 3)
// ─────────────────────────────────────────────

/**
 * Chama a IA no modo consultoria com os resultados calculados
 */
async function responderComResultados(messages, resultadoCalculo, contextoMemoria, apiKey) {
  // Injeta resultado do backend na última mensagem do usuário
  const mensagensComResultado = [...messages];
  const ultimoIdx = [...mensagensComResultado].map(m => m.role).lastIndexOf('user');

  if (ultimoIdx >= 0 && resultadoCalculo) {
    const ultima = mensagensComResultado[ultimoIdx];
    const injecao = `\n\n[RESULTADO_CALCULO]\n${JSON.stringify(resultadoCalculo, null, 2)}\n[/RESULTADO_CALCULO]`;

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
// NORMALIZAÇÃO DE MENSAGENS (mantida do original)
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

  let { messages, contextoMemoria } = req.body || {};

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

    // FASE 1 + 2: se há documento, extrair JSON e calcular no backend
    if (contemDocumento(messages)) {
      const jsonExtraido = await extrairJSON(messages, apiKey);
      if (jsonExtraido) {
        resultadoCalculo = processarJSON(jsonExtraido);
      }
    }

    // FASE 3: resposta final com streaming
    const anthropicResponse = await responderComResultados(
      messages,
      resultadoCalculo,
      contextoMemoria,
      apiKey
    );

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.json();
      return res.status(400).json({ error: err.error?.message || 'Erro na API.' });
    }

    // Streaming SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Se houve cálculo, envia metadado antes do streaming de texto
    if (resultadoCalculo && !resultadoCalculo.erro) {
      res.write(`data: ${JSON.stringify({ tipo: 'resultado_calculo', dados: resultadoCalculo })}\n\n`);
    }

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
