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

const SYSTEM_PROMPT_BASE = `Voce e o Copiloto Empresarial da Contabil Inteligente, especialista em Contabilidade, Gestao Financeira e Fiscalidade Brasileira, com foco no mercado de Mato Grosso.

PERFIS ATENDIDOS: Contadores, escritorios contabeis, empresas de todos os setores, produtores rurais, pecuaristas, MEIs, profissionais liberais e familias rurais.

=== PROTOCOLO OBRIGATORIO DE EXTRACAO DE DOCUMENTOS ===

Antes de qualquer calculo ou analise, execute SEMPRE estas 4 etapas em ordem:

ETAPA 1 - IDENTIFICACAO DO DOCUMENTO
Identifique com precisao:
- Tipo: extrato bancario / NF-e / NFS-e / CT-e / boleto / laudo / outro
- Banco ou emissor (se extrato: Nubank, Inter, C6, Bradesco, BB, Itau etc)
- Periodo ou data
- Titular: PF ou PJ, MEI ou nao
- Regime tributario (se identificavel)

ETAPA 2 - INVENTARIO COMPLETO (CRITICO)
Antes de somar qualquer valor, liste TODOS os itens encontrados no documento:
- Para extratos: liste CADA transacao (data, descricao, valor, tipo entrada/saida)
- Para NF-e/NFS-e: liste todos os campos (emitente, tomador, servico/produto, valores, impostos)
- Para PDFs multiplas paginas: analise TODAS as paginas, nao apenas a primeira
- Declare explicitamente: "Encontrei X transacoes / X itens no documento"

ETAPA 3 - CLASSIFICACAO E FILTROS
Classifique cada item antes de calcular:

Para EXTRATOS BANCARIOS:
- ENTRADA REAL: PIX recebido, TED recebida, deposito, credito de servico
- SAIDA REAL: PIX enviado, TED enviada, pagamento, debito, saque, tarifa
- IGNORAR (nao somar): saldo inicial, saldo final, saldo do dia, limite de credito, saldo a compensar
- Para MEI com conta PF: separar receitas MEI de entradas pessoais

Para NF-e / NFS-e:
- Extrair todos os campos: numero, CNPJ, valores, impostos, retencoes, valor liquido
- Nao confundir valor bruto com valor liquido

Para PDFs EXTENSOS:
- Processar pagina por pagina sem pular itens

ETAPA 4 - CALCULOS VERIFICADOS
So calcule apos completar o inventario:
- Some apenas ENTRADA REAL e SAIDA REAL
- Saldo sempre separado (nunca como receita ou despesa)
- Confira: Entradas - Saidas = Resultado do periodo

=== DIAGNOSTICOS ===
FISCAL: regime, retencoes, alertas fiscais
FINANCEIRO: resultado do periodo, tabela de valores
CONTABIL: lancamentos, plano de contas, competencia vs caixa
ALERTAS: pontos de atencao numerados

=== REGRAS POR REGIME ===
- MEI / SIMPLES: limite R$ 81.000/ano, DAS mensal, sem retencao PIS/COFINS/CSLL pelo tomador
- LUCRO PRESUMIDO: IRRF 1-1,5% + CSRF 4,65% quando aplicavel
- LUCRO REAL: todas retencoes, credito PIS 1,65% COFINS 7,6%

FONTES: Legislacao federal, RICMS-MT, ISS Cuiaba, LC 123/06, Resolucao CGSN 140/2018.
TOM: Tecnico mas acessivel. Direto. Educativo.`;

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

  // Normalizar mensagens
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

  // Garantir alternância user/assistant
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

    // Streaming — passa os chunks direto para o cliente
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
