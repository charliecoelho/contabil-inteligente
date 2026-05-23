/**
 * CONTÁBIL INTELIGENTE — Módulo de Memória Inteligente
 * Arquivo: memoria.js
 *
 * Sistema de aprendizado em duas camadas:
 *   1. memoria_global  — padrões aprendidos de TODOS os clientes (sem dados sensíveis)
 *   2. memoria_cliente — contexto específico de cada cliente (uid)
 *
 * Como usar:
 *   import { salvarMemoria, carregarContexto } from '/memoria.js';
 *
 *   Após cada análise:
 *     await salvarMemoria(uid, empresa, pergunta, resposta);
 *
 *   Antes de cada chamada à API:
 *     const contexto = await carregarContexto(uid);
 *     // injete contexto.sistemaExtra no system prompt do chat.js
 */

import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── Configuração ──────────────────────────────────────────────────────────────

// Máximo de padrões globais injetados no prompt (evita exceder tokens)
const MAX_PADROES_GLOBAIS  = 8;
// Máximo de entradas do histórico do cliente injetadas no prompt
const MAX_HISTORICO_CLIENTE = 6;

// ─── Extração de padrões (sem dados sensíveis) ─────────────────────────────────

/**
 * Extrai padrões reutilizáveis de uma análise.
 * NUNCA inclui: CNPJ, CPF, nomes de empresas, valores específicos, datas.
 * Inclui: tipo de documento, regime, alertas recorrentes, estruturas encontradas.
 */
function extrairPadroes(pergunta, resposta) {
  const padroes = [];
  const r = resposta.toLowerCase();
  const p = pergunta.toLowerCase();

  // Tipo de documento identificado
  const tiposDoc = [
    { chave: 'extrato', label: 'Extrato bancário' },
    { chave: 'nf-e',    label: 'NF-e' },
    { chave: 'nfs-e',   label: 'NFS-e' },
    { chave: 'ct-e',    label: 'CT-e' },
    { chave: 'boleto',  label: 'Boleto' },
    { chave: 'dre',     label: 'DRE' },
    { chave: 'balancete', label: 'Balancete' },
    { chave: 'folha',   label: 'Folha de pagamento' },
  ];
  const tiposEncontrados = tiposDoc.filter(t => r.includes(t.chave) || p.includes(t.chave));

  // Regime tributário identificado
  let regime = null;
  if (r.includes('simples nacional') || r.includes('mei')) regime = 'Simples Nacional / MEI';
  else if (r.includes('lucro presumido')) regime = 'Lucro Presumido';
  else if (r.includes('lucro real')) regime = 'Lucro Real';

  // Alertas e riscos recorrentes (texto genérico, sem valores)
  const alertas = [];
  if (r.includes('icms-st')) alertas.push('Documentos deste tipo frequentemente contêm ICMS-ST');
  if (r.includes('retenção') || r.includes('retencao')) alertas.push('Verificar retenções na fonte');
  if (r.includes('saldo inicial') || r.includes('saldo final')) alertas.push('Extratos contêm saldo — não somar como receita');
  if (r.includes('das')) alertas.push('Cliente com obrigação de DAS mensal');
  if (r.includes('carne-leão') || r.includes('carnê-leão')) alertas.push('Verificar carnê-leão para rendimentos autônomos');
  if (r.includes('transferência pessoal') || r.includes('uso pessoal')) alertas.push('Separar entradas pessoais de receitas MEI/PJ');
  if (r.includes('cfop')) alertas.push('Documento com CFOP — verificar classificação fiscal');

  // Montar padrões apenas se há conteúdo útil
  if (tiposEncontrados.length > 0 && regime) {
    padroes.push(`${tiposEncontrados.map(t => t.label).join(' / ')} com regime ${regime} — análise realizada com sucesso`);
  }
  alertas.forEach(a => padroes.push(a));

  return padroes.filter(Boolean).slice(0, 4); // máximo 4 padrões por análise
}

// ─── Salvar memória após análise ───────────────────────────────────────────────

/**
 * Chamado após cada análise bem-sucedida.
 * Salva contexto do cliente E padrões genéricos na base global.
 *
 * @param {object} db        - instância do Firestore
 * @param {string} uid       - UID do usuário autenticado
 * @param {object} empresa   - { nomeEmpresa, plano, segmento? }
 * @param {string} pergunta  - texto da pergunta (sem arquivos)
 * @param {string} resposta  - resposta completa do Claude
 */
export async function salvarMemoria(db, uid, empresa, pergunta, resposta) {
  if (!db || !uid) return;

  const agora = new Date().toISOString();

  // ── 1. Memória do cliente ──────────────────────────────────────────────────
  try {
    const refCliente = doc(db, 'memoria_cliente', uid);
    const snapCliente = await getDoc(refCliente);

    // Resumo desta análise (sem dados sensíveis como CNPJ/valores exatos)
    const resumoAnalise = {
      data: agora,
      tipoConsulta: pergunta.substring(0, 80),
      temRisco: resposta.toLowerCase().includes('risco') || resposta.includes('⚠️'),
      temEconomia: /R\$\s*[\d.,]+/.test(resposta),
      // Extrair regime tributário se identificado
      regime: (() => {
        const r = resposta.toLowerCase();
        if (r.includes('simples nacional')) return 'Simples Nacional';
        if (r.includes('mei')) return 'MEI';
        if (r.includes('lucro presumido')) return 'Lucro Presumido';
        if (r.includes('lucro real')) return 'Lucro Real';
        return null;
      })(),
      // Tipos de documentos encontrados
      tiposDoc: ['extrato', 'nf-e', 'nfs-e', 'ct-e', 'dre', 'balancete', 'boleto', 'folha']
        .filter(t => resposta.toLowerCase().includes(t))
        .slice(0, 3),
    };

    if (snapCliente.exists()) {
      // Atualizar cliente existente — adicionar ao histórico, manter últimos 20
      const dadosAtuais = snapCliente.data();
      const historico = dadosAtuais.historico || [];
      const novoHistorico = [resumoAnalise, ...historico].slice(0, 20);

      // Atualizar regime se identificado nesta análise
      const update = {
        ultimaAnalise: agora,
        totalAnalises: (dadosAtuais.totalAnalises || 0) + 1,
        historico: novoHistorico,
      };
      if (resumoAnalise.regime) update.regimeIdentificado = resumoAnalise.regime;
      if (empresa.plano) update.plano = empresa.plano;

      await updateDoc(refCliente, update);
    } else {
      // Criar perfil do cliente
      await setDoc(refCliente, {
        uid,
        nomeEmpresa: empresa.nomeEmpresa || 'Cliente',
        plano: empresa.plano || 'Básico',
        regimeIdentificado: resumoAnalise.regime || null,
        criado: agora,
        ultimaAnalise: agora,
        totalAnalises: 1,
        historico: [resumoAnalise],
      });
    }
  } catch (e) {
    console.warn('[Memória] Erro ao salvar memória do cliente:', e);
  }

  // ── 2. Memória global (padrões anônimos) ───────────────────────────────────
  try {
    const padroes = extrairPadroes(pergunta, resposta);
    if (padroes.length === 0) return;

    const refGlobal = doc(db, 'memoria_global', 'padroes');
    const snapGlobal = await getDoc(refGlobal);

    if (snapGlobal.exists()) {
      const dadosGlobais = snapGlobal.data();
      const listaPadroes = dadosGlobais.lista || [];

      // Adicionar apenas padrões que ainda não existem (evitar duplicatas)
      const novos = padroes.filter(p =>
        !listaPadroes.some(existente => existente.texto === p)
      );

      if (novos.length > 0) {
        const novosPadroes = novos.map(p => ({
          texto: p,
          ocorrencias: 1,
          criado: agora,
        }));

        // Manter lista limitada a 100 padrões globais
        const listaAtualizada = [...novosPadroes, ...listaPadroes].slice(0, 100);
        await updateDoc(refGlobal, { lista: listaAtualizada, atualizado: agora });
      } else {
        // Incrementar ocorrências dos padrões já existentes
        const listaAtualizada = listaPadroes.map(existente => {
          if (padroes.includes(existente.texto)) {
            return { ...existente, ocorrencias: (existente.ocorrencias || 1) + 1 };
          }
          return existente;
        });
        await updateDoc(refGlobal, { lista: listaAtualizada, atualizado: agora });
      }
    } else {
      // Criar base global pela primeira vez
      await setDoc(refGlobal, {
        lista: padroes.map(p => ({ texto: p, ocorrencias: 1, criado: agora })),
        criado: agora,
        atualizado: agora,
      });
    }
  } catch (e) {
    console.warn('[Memória] Erro ao salvar memória global:', e);
  }
}

// ─── Carregar contexto para injeção no prompt ──────────────────────────────────

/**
 * Carrega o contexto combinado (global + cliente) para injetar no prompt.
 * Retorna um objeto com o texto pronto para o system prompt.
 *
 * @param {object} db  - instância do Firestore
 * @param {string} uid - UID do usuário autenticado
 * @returns {{ sistemaExtra: string, temContexto: boolean }}
 */
export async function carregarContexto(db, uid) {
  if (!db || !uid) return { sistemaExtra: '', temContexto: false };

  let blocoGlobal  = '';
  let blocoCliente = '';

  // ── 1. Carregar padrões globais ────────────────────────────────────────────
  try {
    const snapGlobal = await getDoc(doc(db, 'memoria_global', 'padroes'));
    if (snapGlobal.exists()) {
      const lista = snapGlobal.data().lista || [];
      // Priorizar padrões com mais ocorrências
      const top = lista
        .sort((a, b) => (b.ocorrencias || 1) - (a.ocorrencias || 1))
        .slice(0, MAX_PADROES_GLOBAIS)
        .map(p => `- ${p.texto}`)
        .join('\n');

      if (top) {
        blocoGlobal = `\n=== PADRÕES APRENDIDOS DO SISTEMA ===\nBaseado em análises anteriores de múltiplos clientes, atenção especial para:\n${top}\n`;
      }
    }
  } catch (e) {
    console.warn('[Memória] Erro ao carregar padrões globais:', e);
  }

  // ── 2. Carregar contexto do cliente ───────────────────────────────────────
  try {
    const snapCliente = await getDoc(doc(db, 'memoria_cliente', uid));
    if (snapCliente.exists()) {
      const dados = snapCliente.data();
      const historico = dados.historico || [];
      const regime = dados.regimeIdentificado;
      const totalAnalises = dados.totalAnalises || 0;

      // Montar bloco de contexto do cliente
      const linhas = [];
      if (regime) linhas.push(`- Regime tributário identificado anteriormente: ${regime}`);
      if (totalAnalises > 0) linhas.push(`- Este cliente já realizou ${totalAnalises} análise(s) no sistema`);

      // Tipos de documentos que este cliente costuma enviar
      const tiposFrequentes = {};
      historico.slice(0, 10).forEach(h => {
        (h.tiposDoc || []).forEach(t => {
          tiposFrequentes[t] = (tiposFrequentes[t] || 0) + 1;
        });
      });
      const tiposOrdenados = Object.entries(tiposFrequentes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t);
      if (tiposOrdenados.length > 0) {
        linhas.push(`- Tipos de documento mais enviados por este cliente: ${tiposOrdenados.join(', ')}`);
      }

      // Riscos recorrentes
      const totalRiscos = historico.filter(h => h.temRisco).length;
      if (totalRiscos > 2) {
        linhas.push(`- Atenção: este cliente apresentou alertas fiscais em ${totalRiscos} análise(s) anteriores`);
      }

      if (linhas.length > 0) {
        blocoCliente = `\n=== CONTEXTO DESTE CLIENTE ===\n${linhas.slice(0, MAX_HISTORICO_CLIENTE).join('\n')}\n`;
      }
    }
  } catch (e) {
    console.warn('[Memória] Erro ao carregar contexto do cliente:', e);
  }

  const sistemaExtra = blocoGlobal + blocoCliente;
  return {
    sistemaExtra,
    temContexto: sistemaExtra.trim().length > 0,
  };
}
