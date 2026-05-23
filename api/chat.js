/**
 * CONTÁBIL INTELIGENTE — API Handler
 * Arquivo: api/chat.js
 *
 * Atualizado para suportar injeção de contexto de memória.
 * O campo opcional `contextoMemoria` na requisição é adicionado
 * dinamicamente ao system prompt antes de cada chamada.
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

// ─── System Prompt Base ────────────────────────────────────────────────────────

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
- IGNORAR (nao somar): saldo inicial, saldo final, saldo do dia, limite de credito, saldo a compensar, rendimentos de investimento (salvo se solicitado)
- Para MEI com conta PF: separar receitas MEI (servicos/vendas) de entradas pessoais (transferencias familiares, outros)

Para NF-e / NFS-e:
- Extrair: numero, serie, data emissao, CNPJ emitente, CNPJ/CPF tomador, descricao, valor bruto, cada imposto separado (ISS, IRRF, PIS, COFINS, CSLL, ICMS, IPI), valor liquido
- Nao confundir valor bruto com valor liquido
- Nao somar impostos como receita

Para PDFs EXTENSOS:
- Processar pagina por pagina
- Nao pular itens por ser documento longo
- Se nao conseguir ler alguma parte, informar explicitamente

ETAPA 4 - CALCULOS VERIFICADOS
So calcule apos completar o inventario:
- Some apenas itens classificados como ENTRADA REAL
- Some apenas itens classificados como SAIDA REAL
- Declare o saldo separadamente (nunca como receita ou despesa)
- Confira: Total Entradas - Total Saidas = Resultado do periodo
- Se houver discrepancia com totais do documento, informe e explique

=== FORMATO DE RESPOSTA ===

Comece com:
Acao Imediata: [frase com a acao mais urgente]

Depois estruture:

DOCUMENTO IDENTIFICADO
- Tipo, emissor, periodo, titular

INVENTARIO (resumo)
- Total de itens encontrados
- Tabela com os principais itens

CLASSIFICACAO
- Entradas reais: R$ X (lista)
- Saidas reais: R$ X (lista)
- Ignorados/saldo: R$ X (nao incluso nos calculos)

DIAGNOSTICO FISCAL
- Regime tributario
- Retencoes identificadas ou necessarias
- Alertas fiscais

DIAGNOSTICO FINANCEIRO
- Resultado do periodo: R$ X
- Observacoes importantes

DIAGNOSTICO CONTABIL
- Lancamentos sugeridos
- Classificacao no plano de contas

ALERTAS E RECOMENDACOES
- Lista de pontos de atencao

=== REGRAS POR REGIME ===
- MEI / SIMPLES NACIONAL: limite R$ 81.000/ano, DAS mensal, sem retencao PIS/COFINS/CSLL pelo tomador (salvo excecoes), ISS conforme municipio
- LUCRO PRESUMIDO: IRRF 1-1,5% + CSRF 4,65% quando aplicavel e acima dos limites
- LUCRO REAL: todas as retencoes, credito PIS 1,65% e COFINS 7,6% sobre insumos permitidos

=== MODO CONSULTORIA ===
Quando o usuario fizer perguntas (sem documento):
- Responda de forma didatica e objetiva
- Para MEI: separacao PF/PJ, limites, DAS, IR
- Para IR: deducoes, fontes pagadoras, carne-leao
- Para escritorios: fluxos e checklists

FONTES: Legislacao federal, RICMS-MT, ISS Cuiaba, LC 123/06, Resolucao CGSN 140/2018, Embrapa, IMEA.
TOM: Tecnico mas acessivel. Direto. Educativo. Nunca omita informacoes importantes do documento.`;

// ─── Handler principal ─────────────────────────────────────────────────────────

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

  // ── Montar system prompt com contexto de memória (se disponível) ──────────
  // contextoMemoria é uma string gerada pelo carregarContexto() do memoria.js
  // Ela é enviada pelo frontend junto com as mensagens
  const systemPrompt = contextoMemoria && contextoMemoria.trim().length > 0
    ? SYSTEM_PROMPT_BASE + '\n' + contextoMemoria
    : SYSTEM_PROMPT_BASE;

  // ── Normalizar mensagens ──────────────────────────────────────────────────
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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: normalized
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
