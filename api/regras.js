/**
 * CONTÁBIL INTELIGENTE — Guardrails Fiscais Determinísticos
 * Arquivo: api/regras.js
 *
 * Regras fiscais em CÓDIGO (nunca em prompt).
 * Chamado pelo api/chat.js para validar e calcular após extração JSON da IA.
 */

// ─────────────────────────────────────────────
// CONSTANTES FISCAIS
// ─────────────────────────────────────────────

const LIMITE_ANUAL_MEI = 81000;
const LIMITE_MENSAL_MEI = LIMITE_ANUAL_MEI / 12; // ~6.750

// Alíquotas CSRF (IRRF + PIS + COFINS + CSLL) por regime
const ALIQUOTAS = {
  simples: {
    irrf: 0,
    pis: 0,
    cofins: 0,
    csll: 0,
    iss: 0, // MEI nunca retém ISS sobre si mesmo
  },
  mei: {
    irrf: 0,
    pis: 0,
    cofins: 0,
    csll: 0,
    iss: 0, // REGRA CRÍTICA: MEI nunca sofre retenção ISS como prestador
  },
  presumido: {
    irrf: 0.015,   // 1,5% serviços em geral
    pis: 0.0065,
    cofins: 0.03,
    csll: 0.01,
    iss: null,     // varia por município — não calcular automaticamente
  },
  real: {
    irrf: 0.015,
    pis: 0.0165,   // crédito
    cofins: 0.076, // crédito
    csll: 0.01,
    iss: null,
  }
};

// Descritores que indicam SALDO (nunca somar como receita/despesa)
const DESCRITORES_SALDO = [
  'saldo inicial',
  'saldo final',
  'saldo do dia',
  'saldo anterior',
  'saldo atual',
  'limite disponivel',
  'limite de credito',
  'saldo disponivel',
  'saldo em conta',
];

// Descritores que indicam ENTRADA REAL
const DESCRITORES_ENTRADA = [
  'pix recebido',
  'ted recebida',
  'doc recebido',
  'deposito',
  'credito',
  'transferencia recebida',
  'pagamento recebido',
  'receita',
  'venda',
  'servico prestado',
  'boleto recebido',
  'estorno de debito',
];

// Descritores que indicam SAÍDA REAL
const DESCRITORES_SAIDA = [
  'pix enviado',
  'pix realizado',
  'ted enviada',
  'doc enviado',
  'pagamento',
  'debito',
  'saque',
  'tarifa',
  'taxa',
  'transferencia enviada',
  'compra',
  'cartao',
  'iof',
  'juros',
  'estorno de credito',
  'devolucao pix',
];

// ─────────────────────────────────────────────
// FUNÇÕES DE GUARDRAIL
// ─────────────────────────────────────────────

/**
 * Normaliza string para comparação (sem acentos, minúsculo)
 */
function normalizar(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Verifica se um descritor é saldo (deve ser ignorado nos cálculos)
 * @param {string} descricao
 * @returns {boolean}
 */
function ehSaldo(descricao) {
  const norm = normalizar(descricao);
  return DESCRITORES_SALDO.some(s => norm.includes(normalizar(s)));
}

/**
 * Classifica uma transação como 'entrada', 'saida' ou 'saldo'
 * Regra: saldo sempre ignorado — nunca vira receita nem despesa.
 * @param {{ descricao: string, valor: number, tipo?: string }} transacao
 * @returns {'entrada' | 'saida' | 'saldo'}
 */
function classificarTransacao(transacao) {
  const norm = normalizar(transacao.descricao || '');

  // GUARDRAIL 1: saldo nunca é receita nem despesa
  if (ehSaldo(norm)) return 'saldo';

  // Se a IA já classificou, respeitar — exceto se for saldo disfarçado
  if (transacao.tipo === 'saldo') return 'saldo';
  if (transacao.tipo === 'entrada') return 'entrada';
  if (transacao.tipo === 'saida') return 'saida';

  // Classificação por descritor
  if (DESCRITORES_ENTRADA.some(e => norm.includes(normalizar(e)))) return 'entrada';
  if (DESCRITORES_SAIDA.some(s => norm.includes(normalizar(s)))) return 'saida';

  // Fallback: valor positivo = entrada, negativo = saída
  return transacao.valor >= 0 ? 'entrada' : 'saida';
}

/**
 * GUARDRAIL MEI/ISS — MEI nunca sofre retenção de ISS como prestador
 * @param {object} retencoes — objeto com retenções calculadas
 * @param {string} regime — 'mei' | 'simples' | 'presumido' | 'real'
 * @returns {object} retencoes corrigidas
 */
function aplicarGuardrailMEI(retencoes, regime) {
  if (!retencoes || typeof retencoes !== 'object') return retencoes;
  const reg = normalizar(regime || '');
  if (reg === 'mei' || reg === 'simples nacional mei') {
    return { ...retencoes, iss: 0 };
  }
  return retencoes;
}

/**
 * Calcula totais de um extrato bancário a partir do JSON extraído pela IA.
 * TODOS os cálculos matemáticos acontecem aqui — nunca na IA.
 *
 * @param {Array<{ descricao: string, valor: number, tipo?: string }>} transacoes
 * @param {string} regime — 'mei' | 'simples' | 'presumido' | 'real'
 * @returns {{
 *   totalEntradas: number,
 *   totalSaidas: number,
 *   resultado: number,
 *   qtdEntradas: number,
 *   qtdSaidas: number,
 *   qtdSaldosIgnorados: number,
 *   transacoesClassificadas: Array,
 *   alertas: Array<string>
 * }}
 */
function calcularExtrato(transacoes, regime = 'simples') {
  if (!Array.isArray(transacoes) || transacoes.length === 0) {
    return {
      totalEntradas: 0,
      totalSaidas: 0,
      resultado: 0,
      qtdEntradas: 0,
      qtdSaidas: 0,
      qtdSaldosIgnorados: 0,
      transacoesClassificadas: [],
      alertas: ['Nenhuma transação encontrada no documento.']
    };
  }

  const alertas = [];
  let totalEntradas = 0;
  let totalSaidas = 0;
  let qtdSaldosIgnorados = 0;

  const transacoesClassificadas = transacoes.map(t => {
    const valor = parseFloat(t.valor) || 0;
    const classificacao = classificarTransacao({ ...t, valor });

    if (classificacao === 'saldo') {
      qtdSaldosIgnorados++;
      return { ...t, valor, classificacao };
    }

    if (classificacao === 'entrada') {
      totalEntradas += Math.abs(valor);
    } else {
      totalSaidas += Math.abs(valor);
    }

    return { ...t, valor, classificacao };
  });

  const resultado = totalEntradas - totalSaidas;

  // Alertas MEI
  const reg = normalizar(regime);
  if (reg === 'mei') {
    if (totalEntradas > LIMITE_MENSAL_MEI) {
      alertas.push(
        `⚠️ Entradas de ${formatarMoeda(totalEntradas)} superam o limite mensal MEI (${formatarMoeda(LIMITE_MENSAL_MEI)}). Verifique o limite anual de R$ 81.000.`
      );
    }
    alertas.push('ℹ️ MEI: ISS não retido sobre receitas de serviço (regra fiscal aplicada).');
  }

  if (qtdSaldosIgnorados > 0) {
    alertas.push(`ℹ️ ${qtdSaldosIgnorados} linha(s) de saldo ignorada(s) nos cálculos (correto).`);
  }

  return {
    totalEntradas: arredondar(totalEntradas),
    totalSaidas: arredondar(totalSaidas),
    resultado: arredondar(resultado),
    qtdEntradas: transacoesClassificadas.filter(t => t.classificacao === 'entrada').length,
    qtdSaidas: transacoesClassificadas.filter(t => t.classificacao === 'saida').length,
    qtdSaldosIgnorados,
    transacoesClassificadas,
    alertas
  };
}

/**
 * Calcula retenções sobre uma NFS-e / NF-e
 * @param {{ valorBruto: number, regime: string, tipoServico?: string }} params
 * @returns {{ irrf: number, pis: number, cofins: number, csll: number, iss: number|null, valorLiquido: number, alertas: string[] }}
 */
function calcularRetencoes({ valorBruto, regime, tipoServico }) {
  const reg = normalizar(regime || 'simples');
  const aliq = ALIQUOTAS[reg] || ALIQUOTAS.simples;
  const bruto = parseFloat(valorBruto) || 0;
  const alertas = [];

  let retencoes = {
    irrf:   arredondar(bruto * aliq.irrf),
    pis:    arredondar(bruto * aliq.pis),
    cofins: arredondar(bruto * aliq.cofins),
    csll:   arredondar(bruto * aliq.csll),
    iss:    aliq.iss !== null ? arredondar(bruto * (aliq.iss || 0)) : null,
  };

  // GUARDRAIL MEI — zera ISS se for MEI
  retencoes = aplicarGuardrailMEI(retencoes, reg);

  if (reg === 'mei') {
    alertas.push('ℹ️ MEI: sem retenção de ISS, PIS, COFINS e CSLL (lei complementar 123/2006).');
  }

  if (aliq.iss === null) {
    alertas.push('ℹ️ ISS varia por município — consulte a legislação local (ex: ISS Cuiabá).');
  }

  const totalRetencoes = retencoes.irrf + retencoes.pis + retencoes.cofins + retencoes.csll + (retencoes.iss || 0);
  const valorLiquido = arredondar(bruto - totalRetencoes);

  return { ...retencoes, totalRetencoes: arredondar(totalRetencoes), valorLiquido, alertas };
}

/**
 * Valida o JSON extraído pela IA antes de processar
 * @param {object} json
 * @returns {{ valido: boolean, erros: string[] }}
 */
function validarJsonExtrato(json) {
  const erros = [];

  if (!json || typeof json !== 'object') {
    erros.push('JSON inválido ou ausente.');
    return { valido: false, erros };
  }

  if (!Array.isArray(json.transacoes)) {
    erros.push('Campo "transacoes" ausente ou não é array.');
  } else if (json.transacoes.length === 0) {
    erros.push('Nenhuma transação encontrada no JSON.');
  } else {
    json.transacoes.forEach((t, i) => {
      if (t.valor === undefined || t.valor === null) {
        erros.push(`Transação ${i + 1}: campo "valor" ausente.`);
      }
      if (!t.descricao) {
        erros.push(`Transação ${i + 1}: campo "descricao" ausente.`);
      }
    });
  }

  return { valido: erros.length === 0, erros };
}

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────

function arredondar(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

export {
  calcularExtrato,
  calcularRetencoes,
  classificarTransacao,
  validarJsonExtrato,
  aplicarGuardrailMEI,
  ehSaldo,
  formatarMoeda,
  arredondar,
  LIMITE_ANUAL_MEI,
  LIMITE_MENSAL_MEI,
  ALIQUOTAS,
};
