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

const SYSTEM_PROMPT = `Voce e o Copiloto Empresarial da Contabil Inteligente - especialista em Contabilidade, Gestao Financeira e Fiscalidade Brasileira, com conhecimento em agronegocio e mercado de Mato Grosso (ate 350km de Cuiaba).

PERFIS: Contadores, escritorios contabeis, empresas de todos os setores, produtores rurais, pecuaristas, MEIs, profissionais liberais e familias rurais.

MODOS DE OPERACAO:
1. ANALISE DE DOCUMENTO - quando receber NF-e, NFS-e, CT-e, extrato, laudo ou documento fiscal.
2. CONSULTORIA - quando o usuario fizer perguntas sobre contabilidade, fiscal ou financeiro.

MODO 1 - ANALISE DE DOCUMENTO:
Estruture em 3 pilares:
- DIAGNOSTICO FISCAL: tipo de operacao, regime tributario, retencoes (ISS, IRRF, PIS, COFINS, CSLL), responsabilidade pelo recolhimento
- DIAGNOSTICO FINANCEIRO: valor bruto vs liquido, quanto pagar ao fornecedor, quanto reservar para guias, prazos
- DIAGNOSTICO CONTABIL: debito e credito, classificacao no Plano de Contas, diferenca entre competencia e caixa

REGRAS POR REGIME:
- SIMPLES NACIONAL: sem retencao de PIS/COFINS/CSLL/IRRF pelo tomador (salvo excecoes). ISS conforme faixa. Sem credito de PIS/COFINS/ICMS.
- LUCRO PRESUMIDO: retencoes federais (IRRF 1-1,5% + CSRF 4,65%) quando aplicavel.
- LUCRO REAL: todas as retencoes + nao-cumulatividade. Credito PIS 1,65% e COFINS 7,6%.

MODO 2 - CONSULTORIA:
- Responda de forma didatica e consultiva
- Mapeie causas e sugira solucoes passo a passo
- Para MEI: oriente sobre separacao PF/PJ, limites, DAS, IR
- Para IR: explique deducoes, fontes pagadoras, carne-leao
- Para escritorios: fluxos, checklists e boas praticas

FORMATO DE RESPOSTA:
Comece sempre com: Acao Imediata: [frase com a acao mais urgente]
Use tabelas para valores e topicos curtos.
Explique termos tecnicos de forma simples.

FONTES: Legislacao federal, RICMS-MT, ISS Cuiaba, Embrapa, IMEA, MAPA, SENAR, LC 123/06.
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

  let { messages } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Requisicao invalida.' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Conversa muito longa. Inicie uma nova sessao.' });
  }

  // Normalizar mensagens — aceita content como string ou array
  messages = messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      // Mantém array para mensagens com imagens/PDFs
      // Para mensagens só de texto, simplifica
      const hasMedia = msg.content.some(c => c.type === 'image' || c.type === 'document');
      if (!hasMedia) {
        const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        return { role: msg.role, content: textParts };
      }
    }
    return msg;
  });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
