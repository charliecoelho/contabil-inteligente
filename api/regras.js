/**
 * CONTÁBIL INTELIGENTE — Guardrails Fiscais Determinísticos
 * Arquivo: api/regras.js
 */

const LIMITE_ANUAL_MEI = 81000;
const LIMITE_MENSAL_MEI = LIMITE_ANUAL_MEI / 12;

const ALIQUOTAS = {
  simples: { irrf: 0, pis: 0, cofins: 0, csll: 0, iss: 0 },
  mei:     { irrf: 0, pis: 0, cofins: 0, csll: 0, iss: 0 },
  presumido: { irrf: 0.015, pis: 0.0065, cofins: 0.03, csll: 0.01, iss: null },
  real:      { irrf: 0.015, pis: 0.0165, cofins: 0.076, csll: 0.01, iss: null }
};

const DESCRITORES_SALDO = ['saldo inicial','saldo final','saldo do dia','saldo anterior','saldo atual','limite disponivel','limite de credito','saldo disponivel','saldo em conta'];
const DESCRITORES_ENTRADA = ['pix recebido','ted recebida','doc recebido','deposito','credito','transferencia recebida','pagamento recebido','receita','venda','servico prestado','boleto recebido','estorno de debito'];
const DESCRITORES_SAIDA = ['pix enviado','pix realizado','ted enviada','doc enviado','pagamento','debito','saque','tarifa','taxa','transferencia enviada','compra','cartao','iof','juros','estorno de credito','devolucao pix'];

function normalizar(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function ehSaldo(descricao) {
  const norm = normalizar(descricao);
  return DESCRITORES_SALDO.some(s => norm.includes(normalizar(s)));
}

function classificarTransacao(transacao) {
  const norm = normalizar(transacao.descricao || '');
  if (ehSaldo(norm)) return 'saldo';
  if (transacao.tipo === 'saldo') return 'saldo';
  if (transacao.tipo === 'entrada') return 'entrada';
  if (transacao.tipo === 'saida') return 'saida';
  if (DESCRITORES_ENTRADA.some(e => norm.includes(normalizar(e)))) return 'entrada';
  if (DESCRITORES_SAIDA.some(s => norm.includes(normalizar(s)))) return 'saida';
  return transacao.valor >= 0 ? 'entrada' : 'saida';
}

function aplicarGuardrailMEI(retencoes, regime) {
  if (!retencoes || typeof retencoes !== 'object') return retencoes;
  const reg = normalizar(regime || '');
  if (reg === 'mei' || reg === 'simples nacional mei') return { ...retencoes, iss: 0 };
  return retencoes;
}

function calcularExtrato(transacoes, regime = 'simples') {
  if (!Array.isArray(transacoes) || transacoes.length === 0) {
    return { totalEntradas: 0, totalSaidas: 0, resultado: 0, qtdEntradas: 0, qtdSaidas: 0, qtdSaldosIgnorados: 0, transacoesClassificadas: [], alertas: ['Nenhuma transação encontrada no documento.'] };
  }
  const alertas = [];
  let totalEntradas = 0, totalSaidas = 0, qtdSaldosIgnorados = 0;
  const transacoesClassificadas = transacoes.map(t => {
    const valor = parseFloat(t.valor) || 0;
    const classificacao = classificarTransacao({ ...t, valor });
    if (classificacao === 'saldo') { qtdSaldosIgnorados++; return { ...t, valor, classificacao }; }
    if (classificacao === 'entrada') totalEntradas += Math.abs(valor);
    else totalSaidas += Math.abs(valor);
    return { ...t, valor, classificacao };
  });
  const resultado = totalEntradas - totalSaidas;
  const reg = normalizar(regime);
  if (reg === 'mei') {
    if (totalEntradas > LIMITE_MENSAL_MEI) alertas.push(`⚠️ Entradas de ${formatarMoeda(totalEntradas)} superam o limite mensal MEI (${formatarMoeda(LIMITE_MENSAL_MEI)}). Verifique o limite anual de R$ 81.000.`);
    alertas.push('ℹ️ MEI: ISS não retido sobre receitas de serviço (regra fiscal aplicada).');
  }
  if (qtdSaldosIgnorados > 0) alertas.push(`ℹ️ ${qtdSaldosIgnorados} linha(s) de saldo ignorada(s) nos cálculos (correto).`);
  return {
    totalEntradas: arredondar(totalEntradas), totalSaidas: arredondar(totalSaidas), resultado: arredondar(resultado),
    qtdEntradas: transacoesClassificadas.filter(t => t.classificacao === 'entrada').length,
    qtdSaidas: transacoesClassificadas.filter(t => t.classificacao === 'saida').length,
    qtdSaldosIgnorados, transacoesClassificadas, alertas
  };
}

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
  retencoes = aplicarGuardrailMEI(retencoes, reg);
  if (reg === 'mei') alertas.push('ℹ️ MEI: sem retenção de ISS, PIS, COFINS e CSLL (lei complementar 123/2006).');
  if (aliq.iss === null) alertas.push('ℹ️ ISS varia por município — consulte a legislação local (ex: ISS Cuiabá).');
  const totalRetencoes = retencoes.irrf + retencoes.pis + retencoes.cofins + retencoes.csll + (retencoes.iss || 0);
  const valorLiquido = arredondar(bruto - totalRetencoes);
  return { ...retencoes, totalRetencoes: arredondar(totalRetencoes), valorLiquido, alertas };
}

function validarJsonExtrato(json) {
  const erros = [];
  if (!json || typeof json !== 'object') { erros.push('JSON inválido ou ausente.'); return { valido: false, erros }; }
  if (!Array.isArray(json.transacoes)) {
    erros.push('Campo "transacoes" ausente ou não é array.');
  } else if (json.transacoes.length === 0) {
    erros.push('Nenhuma transação encontrada no JSON.');
  } else {
    json.transacoes.forEach((t, i) => {
      if (t.valor === undefined || t.valor === null) erros.push(`Transação ${i + 1}: campo "valor" ausente.`);
      if (!t.descricao) erros.push(`Transação ${i + 1}: campo "descricao" ausente.`);
    });
  }
  return { valido: erros.length === 0, erros };
}

function arredondar(valor) { return Math.round((valor + Number.EPSILON) * 100) / 100; }
function formatarMoeda(valor) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor); }

function calcularTaxaSucesso(economia) {
  if (!economia || economia <= 0) return 0;
  if (economia <= 5000)   return arredondar(economia * 0.05);
  if (economia <= 20000)  return arredondar(economia * 0.03);
  if (economia <= 100000) return arredondar(economia * 0.02);
  return arredondar(economia * 0.01);
}

function percentualTaxaSucesso(economia) {
  if (!economia || economia <= 0) return 0;
  if (economia <= 5000)   return 5;
  if (economia <= 20000)  return 3;
  if (economia <= 100000) return 2;
  return 1;
}

function verificarGatilhoUpsell(resultado, planoAtual, economiaIdentificada = 0) {
  const plano = normalizar(planoAtual || '');
  if (!plano.includes('plus')) return { exibir: false, motivo: null, mensagem: null };
  const economia = parseFloat(economiaIdentificada) || 0;
  const totalTransacoes = resultado?.transacoesClassificadas?.length || 0;
  const totalEntradas = resultado?.totalEntradas || 0;
  const temAlertaAlto = Array.isArray(resultado?.alertas) && resultado.alertas.some(a => a.includes('⚠️') || a.toLowerCase().includes('crítico') || a.toLowerCase().includes('alto'));
  const criterios = { economiaAlta: economia > 10000, volumeMassivo: totalTransacoes > 50, alertaAlto: temAlertaAlto, entradasAltas: totalEntradas > 50000 };
  const disparou = Object.values(criterios).some(Boolean);
  if (!disparou) return { exibir: false, motivo: null, mensagem: null };
  let motivo = 'complexidade_fiscal';
  let detalhe = 'complexidade tributária avançada identificada';
  if (criterios.economiaAlta) { motivo = 'volume_financeiro'; detalhe = `economia potencial de ${formatarMoeda(economia)} identificada`; }
  else if (criterios.volumeMassivo) { motivo = 'volume_transacoes'; detalhe = `${totalTransacoes} transações detectadas — volume acima do padrão Plus`; }
  else if (criterios.entradasAltas) { motivo = 'faturamento_alto'; detalhe = `faturamento de ${formatarMoeda(totalEntradas)} no período`; }
  return {
    exibir: true, motivo,
    mensagem: `📈 Esta análise identificou ${detalhe}. O Plano Ultra inclui apuração completa de Lucro Presumido avançado e Lucro Real para volumes desta magnitude, com Gerente de Conta dedicado.`,
    criteriosAtivados: Object.entries(criterios).filter(([, v]) => v).map(([k]) => k),
  };
}

export {
  calcularExtrato, calcularRetencoes, classificarTransacao, validarJsonExtrato,
  aplicarGuardrailMEI, verificarGatilhoUpsell, calcularTaxaSucesso, percentualTaxaSucesso,
  normalizar, ehSaldo, formatarMoeda, arredondar,
  LIMITE_ANUAL_MEI, LIMITE_MENSAL_MEI, ALIQUOTAS,
};
