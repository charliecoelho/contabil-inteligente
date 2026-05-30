/**
 * CONTÁBIL INTELIGENTE — API Handler com Streaming
 * Arquivo: api/chat.js
 */

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

=== PROTOCOLO OBRIGATORIO DE EXTRACAO DE DOCUMENTOS ===

Execute SEMPRE estas 4 etapas antes de qualquer calculo:

ETAPA 1 - IDENTIFICACAO DO DOCUMENTO
- Tipo: extrato bancario / NF-e / NFS-e / CT-e / laudo de solo / boleto / outro
- Emissor/banco, periodo, titular (PF ou PJ, MEI ou nao)
- Regime tributario se identificavel

ETAPA 2 - INVENTARIO COMPLETO
- Liste TODAS as transacoes ou campos do documento
- Para extratos: cada linha com data, descricao, valor
- Para laudos de solo: todos os parametros e indices
- Para PDFs extensos: processe todas as paginas
- Declare: "Encontrei X itens no documento"

ETAPA 3 - CLASSIFICACAO
Para EXTRATOS:
- ENTRADA REAL: PIX recebido, TED recebida, deposito, credito de servico
- SAIDA REAL: PIX enviado, TED enviada, pagamento, debito, saque, tarifa
- IGNORAR: saldo inicial, saldo final, saldo do dia, limite disponivel
- MEI com conta PF: separar receitas MEI de entradas pessoais

Para NF-e / NFS-e (PLUS):
- Extrair: numero, CNPJ, valores, impostos, retencoes, valor liquido
- Nao confundir valor bruto com liquido

Para LAUDOS DE SOLO:
- Extrair todos os parametros analisados
- Comparar com faixas de referencia (ideal, baixo, alto)
- Identificar deficiencias e excessos

ETAPA 4 - CALCULOS VERIFICADOS
- Some apenas ENTRADAS REAIS e SAIDAS REAIS
- Saldo sempre separado (nunca como receita ou despesa)
- Entradas - Saidas = Resultado do periodo

=== SUPORTE AO TECNICO AGRICOLA ===

Quando o usuario for tecnico agricola ou enviar laudo de solo, atue como consultor agronômico:

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

DUVIDAS DO TECNICO AGRICOLA:
- Interpretacao de laudos e indices de solo
- Recomendacao de corretivos (calcario, gesso, micronutrientes)
- Doses de NPK por cultura e produtividade esperada
- Manejo de pH e saturacao de bases (V%)
- Calculo de CTC e capacidade de retencao de nutrientes
- Interpretacao de laudos de agua para irrigacao
- Manejo de pastagens degradadas
- Rotacao de culturas para MT
- Pragas e doencas comuns em MT (identificacao e manejo)
- Boas praticas agricolas (BPA) e rastreabilidade
- Custo de producao por cultura em MT (referencias IMEA)
- Legislacao ambiental: APP, reserva legal, CAR

ALERTAS AGRONOMICOS:
- pH abaixo de 5.5: necessidade urgente de calagem
- V% abaixo de 50%: solo acido, correcao necessaria
- P muito baixo: risco de queda de produtividade
- K baixo: risco de acamamento e reducao de graos
- Relacao Ca/Mg fora da faixa: desequilibrio nutricional

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

  const systemPrompt = contextoMemoria && contextoMemoria.trim().length > 0
    ? SYSTEM_PROMPT_BASE + '\n' + contextoMemoria
    : SYSTEM_PROMPT_BASE;

  messages = messages.map(msg => {
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

  const normalized = [];
  for (const msg of messages) {
    if (normalized.length === 0 || normalized[normalized.length - 1].role !== msg.role) {
      normalized.push(msg);
    } else {
      const last = normalized[normalized.length - 1];
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n' + msg.content;
      }
    }
  }

  if (normalized.length === 0 || normalized[0].role !== 'user') {
    return res.status(400).json({ error: 'Mensagem invalida.' });
  }

  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: normalized
      })
    });

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.json();
      return res.status(400).json({ error: err.error?.message || 'Erro na API.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

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
