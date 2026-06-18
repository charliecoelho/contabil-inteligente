/**
 * CONTÁBIL INTELIGENTE — API Handler
 * Arquivo: api/chat.js
 */

import {
  calcularExtrato,
  calcularRetencoes,
  validarJsonExtrato,
  formatarMoeda,
  verificarGatilhoUpsell,
  calcularTaxaSucesso,
  percentualTaxaSucesso,
  normalizar,
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
  
  // O sistema tratará o enquadramento cruzando os impostos reais pagos no extrato.
  return 'indeterminado'; 
}

async function consultarCNPJ(cnpj) {
  if (!cnpj || cnpj.length !== 14) return null;
  try {
    const resp = await fetch(`https://receitaws.com.br{cnpj}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
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

// ── SYSTEM PROMPT EXTRAÇÃO JSON (REVISADO E BLINDADO) ──
const SYSTEM_PROMPT_JSON = `Voce e um extrator multimodal de dados fiscais e financeiros especializado no mercado brasileiro. Sua unica funcao e analisar visualmente os documentos (PDFs/Imagens) e retornar estritamente um objeto JSON estruturado.

=== DIRETRIZES DE COMPLIANCE OBRIGATORIAS ===
1. NOMENCLATURA DE IMPOSTOS: Mantenha as siglas originais do documento de forma estrita.
   - NUNCA use a sigla "DARF" para guias do Simples Nacional ou MEI. A guia unificada do Simples/MEI chama-se "DAS".
   - O termo "DARF" aplica-se apenas para retencoes federais isoladas ou regimes de Lucro Presumido/Real (IRPJ, CSLL, PIS, COFINS).
2. PROIBICAO DE MATEMATICA: Voce esta terminantemente PROIBIDO de fazer somas de totais, calculos de saldos, calculos de impostos ou porcentagens. Extraia apenas dados brutos linha por linha.

=== SCHEMA JSON REQUERIDO ===
{
  "tipo_documento": "extrato_bancario | nfe | nfse | cte | boleto | outro",
  "banco": "Nubank | Inter | Bradesco | BB | Itau | outro_banco | null",
  "periodo": {
    "data_inicio": "AAAA-MM-DD ou null",
    "data_fim": "AAAA-MM-DD ou null"
  },
  "empresa_identificada": {
    "cnpj": "string ou null",
    "razao_social": "string ou null"
  },
  "transacoes": [
    {
      "id": 1,
      "data": "AAAA-MM-DD",
      "descricao": "texto bruto e literal da transacao ou item conforme o documento",
      "valor": 1500.00,
      "categoria": "entrada_real | saida_real | informativo"
    }
  ]
}

=== REGRAS DE CATEGORIZACAO ===
- entrada_real: PIX recebido, TED recebida, deposito, receita, venda, aporte.
- saida_real: PIX enviado, TED enviada, pagamento de guias (DAS, DARF), tarifas, compras.
- informativo: saldo inicial, saldo final, saldo do dia, limite de credito. (Mantenha o valor numerico original, mas marque como informativo).

=== SAIDA ===
Retorne APENAS o JSON bruto. Nao use blocos de codigo markdown (\`\`\`json). Sem textos explicativos.`;

// ── SYSTEM PROMPT CONSULTORIA (REVISADO) ──
const SYSTEM_PROMPT_BASE = `Voce e o Copiloto Empresarial da Contabil Inteligente, especialista em Auditoria e Fiscalidade Brasileira.

=== REGRA DE OURO DE MATEMATICA ===
O arquivo backend 'regras.js' processou a matemática de forma exata. 
Voce recebera os dados calculados no bloco [RESULTADO_CALCULO].
1. CONFIE cegamente e replique os numeros e percentuais calculados pelo backend.
2. NAO realize calculos mentais de acumulados ou medias de cabeca — use o que foi fornecido.
3. Se os dados apontarem faturamento acumulado alto, adeque o teor dos seus textos explicativos para esse porte.

=== REGRAS DE NOMENCLATURA FISCAL ===
- MEI / SIMPLES NACIONAL: Pagam guia "DAS". Nunca chame de DARF.
- LUCRO PRESUMIDO / REAL: Pagam guias "DARF" separadas por imposto (IRPJ, CSLL, PIS, COFINS). Nunca chame de DAS.

=== FORMATO DE RESPOSTA ===
Comece direto com: Acao Imediata: [frase com a acao mais urgente]
Use as tabelas e os alertas exatamente como computados pelo backend.`;

// ── DETECÇÃO DE DOCUMENTO ──
function contemDocumento(messages) {
  const ultima = [...messages].reverse().find(m => m.role === 'user');
  if (!ultima || !Array.isArray(ultima.content)) return false;
  return ultima.content.some(c => c.type === 'image' || c.type === 'document');
}

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
