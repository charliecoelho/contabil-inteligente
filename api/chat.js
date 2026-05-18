// Rate limiting simples em memória
const rateLimitMap = new Map();
const LIMITE_POR_MINUTO = 15;
const JANELA_MS = 60 * 1000;

function verificarRateLimit(ip) {
  const agora = Date.now();
  const registro = rateLimitMap.get(ip) || { count: 0, inicio: agora };

  if (agora - registro.inicio > JANELA_MS) {
    registro.count = 0;
    registro.inicio = agora;
  }

  registro.count++;
  rateLimitMap.set(ip, registro);

  if (rateLimitMap.size > 200) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (agora - val.inicio > JANELA_MS * 2) rateLimitMap.delete(key);
    }
  }

  return registro.count <= LIMITE_POR_MINUTO;
}

export default async function handler(req, res) {
  // CORS — aceita do domínio próprio
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const allowed = [
    'https://contabilinteligente.api.br',
    'https://contabil-inteligente.vercel.app',
    'http://localhost:3000'
  ];

  const origemPermitida = !origin ||
    allowed.some(a => origin.startsWith(a)) ||
    allowed.some(a => referer.startsWith(a));

  if (!origemPermitida) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // Rate limiting por IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';

  if (!verificarRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde 1 minuto e tente novamente.' });
  }

  // Validar body
  const { messages, system } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida.' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Conversa muito longa. Inicie uma nova sessão.' });
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
        system: system || '',
        messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
