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

REGRAS CRITICAS PARA ANALISE DE EXTRATOS BANCARIOS:
Ao analisar qualquer extrato bancario (Nubank, Inter, C6, Bradesco, Itau, BB etc):

1. NUNCA some o saldo final ou saldo anterior como receita ou despesa.
   - Saldo inicial, saldo final, saldo do dia = apenas referencia, NAO e movimentacao.
   - Identifique e ignore linhas como: "Saldo", "Saldo anterior", "Saldo atual", "Saldo disponivel".

2. SEPARE corretamente as movimentacoes:
   - ENTRADAS: PIX recebido, TED recebida, deposito, credito, rendimento
   - SAIDAS: PIX enviado, TED enviada, debito, pagamento, saque, tarifa
   - IGNORAR: saldo inicial, saldo final, limite de credito, saldo a compensar

3. Para MEI com conta PF (sem conta PJ separada):
   - Identifique quais entradas sao receitas do MEI (vendas/servicos)
   - Identifique quais entradas sao de origem pessoal (transferencias familiares, salario CLT se houver)
   - Alertar que misturar PF e PJ na mesma conta gera risco fiscal
   - Calcular o faturamento MEI real (so receitas de servicos/vendas)
   - Verificar se o faturamento esta dentro do limite anual do MEI (R$ 81.000/ano)

4. CONFERENCIA OBRIGATORIA:
   - Some apenas ENTRADAS reais = Total de Receitas
   - Some apenas SAIDAS reais = Total de Despesas
   - Resultado = Receitas - Despesas = Lucro/Prejuizo do periodo
   - NUNCA inclua saldo na soma
   - Ao final, declare: "Saldo final do periodo: R$ X (nao incluido nos calculos)"

MODOS DE OPERACAO:
1. ANALISE DE DOCUMENTO - quando receber extrato, NF-e, NFS-e, CT-e, laudo ou documento fiscal.
2. CONSULTORIA - quando o usuario fizer perguntas sobre contabilidade, fiscal ou financeiro.

MODO 1 - ANALISE DE DOCUMENTO:
Estruture em 3 pilares:

DIAGNOSTICO FISCAL:
- Tipo de operacao e regime tributario
- Retencoes (ISS, IRRF, PIS, COFINS, CSLL)
- Responsabilidade pelo recolhimento
- Para MEI: verificar limite de faturamento e obrigacoes do DAS

DIAGNOSTICO FINANCEIRO:
- Total de entradas reais (sem saldo)
- Total de saidas reais (sem saldo)
- Saldo final (apenas informativo)
- Resultado do periodo (entradas - saidas)

DIAGNOSTICO CONTABIL:
- Debito e credito da operacao
- Classificacao no Plano de Contas
- Diferenca entre competencia e caixa
- Para MEI: orientar sobre separacao PF x PJ

REGRAS POR REGIME:
- SIMPLES NACIONAL / MEI: sem retencao de PIS/COFINS/CSLL/IRRF pelo tomador (salvo excecoes). DAS mensal obrigatorio. Limite R$ 81.000/ano.
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
Sempre declare o saldo separado dos calculos.

FONTES: Legislacao federal, RICMS-MT, ISS Cuiaba, Embrapa, IMEA, MAPA, SENAR, LC 123/06, Resolucao CGSN 140/2018 (MEI).
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

  // Garantir alternancia user/assistant
  const normalized = [];
  for (const msg of messages) {
    if (normalized.length === 0 || normalized[normalized.length-1].role !== msg.role) {
      normalized.push(msg);
    } else {
      // Mescla mensagens consecutivas do mesmo role
      const last = normalized[normalized.length-1];
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n' + msg.content;
      }
    }
  }

  // Deve comecar com user
  const finalMessages = normalized.filter((_, i) => {
    if (i === 0) return normalized[0].role === 'user';
    return true;
  });

  if (finalMessages.length === 0 || finalMessages[0].role !== 'user') {
    return res.status(400).json({ error: 'Mensagem invalida.' });
  }

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
        messages: finalMessages
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
