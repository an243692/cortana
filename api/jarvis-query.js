const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': '2024-05-01-preview' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY }
});

const firebaseDbUrl = process.env.FIREBASE_DATABASE_URL || "https://gestioncursodocente-default-rtdb.firebaseio.com";

async function firebaseGet(path) {
  const url = `${firebaseDbUrl}/${path}.json`;
  const response = await fetch(url);
  return response.json();
}

const tools = [
  {
    type: "function",
    function: {
      name: "consultar_cursos",
      description: "Consulta los cursos disponibles. Usalo cuando pregunten por cursos, materias o clases.",
      parameters: {
        type: "object",
        properties: {
          tipo: { type: "string", description: "Tipo: basicos, tecnologias, avanzados, especializacion, o todos" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consultar_docentes",
      description: "Consulta informacion de docentes. Usalo cuando pregunten por profesores.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre del docente (opcional)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consultar_estadisticas",
      description: "Estadisticas generales: total cursos, docentes, etc.",
      parameters: { type: "object", properties: {} }
    }
  }
];

async function ejecutarHerramienta(nombre, args) {
  try {
    switch (nombre) {
      case "consultar_cursos": {
        const cursos = await firebaseGet('cursos') || {};
        let lista = Object.entries(cursos).map(([id, c]) => ({
          nombre: c.nombre, tipo: c.tipo, fecha: c.fecha || 'Sin fecha',
          modalidad: c.url ? 'En linea' : 'Presencial'
        }));
        if (args.tipo && args.tipo !== 'todos') lista = lista.filter(c => c.tipo === args.tipo);
        return JSON.stringify({ total: lista.length, cursos: lista });
      }
      case "consultar_docentes": {
        const docentes = await firebaseGet('docentes') || {};
        let lista = Object.entries(docentes).map(([id, d]) => ({
          nombre: `${d.nombre} ${d.apellidos || ''}`, email: d.email, area: d.area || 'No especificada'
        }));
        if (args.nombre) lista = lista.filter(d => d.nombre.toLowerCase().includes(args.nombre.toLowerCase()));
        return JSON.stringify({ total: lista.length, docentes: lista });
      }
      case "consultar_estadisticas": {
        const [cursos, docentes] = await Promise.all([firebaseGet('cursos'), firebaseGet('docentes')]);
        const cursosList = cursos ? Object.values(cursos) : [];
        const tipos = {};
        cursosList.forEach(c => { tipos[c.tipo] = (tipos[c.tipo] || 0) + 1; });
        return JSON.stringify({ totalCursos: cursosList.length, totalDocentes: (docentes ? Object.keys(docentes).length : 0), cursosPorTipo: tipos });
      }
      default: return JSON.stringify({ error: "Herramienta no encontrada" });
    }
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

module.exports = async (req, res) => {
  // Solo permitir POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Método no permitido" });
  }

  // Habilitar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const userMessage = req.body.message || req.body.text;
    if (!userMessage) return res.status(400).json({ error: "Se requiere mensaje" });

    const systemPrompt = `Eres el Agente de Inteligencia Artificial de la Universidad La Salle Nezahualcoyotl. Tu nombre interno es Jarvis.

PERSONALIDAD:
- Eres directo, sarcástico y extremadamente eficiente. Como el Jarvis de Iron Man, pero con sabor mexicano.
- No uses frases de cortesía excesiva. NUNCA digas "Como modelo de lenguaje...", "Entiendo tu pregunta...", "Con gusto te ayudo..." o similares. Esas frases están prohibidas.
- Si la pregunta es obvia o redundante, responde con una pizca de sarcasmo o ironía. No seas grosero, pero tampoco seas un robot servil.
- Usa lenguaje coloquial mexicano técnico cuando sea necesario. Frases como "ya quedó", "chale", "qué oso", "neta", "sale", "va que va" son bienvenidas.
- Sé conciso. Da la respuesta exacta sin rodeos.
- Si no sabes algo o no hay datos, dilo directamente: "No tengo ese dato" o "La base está vacía, carnal".
- Responde en español de México.
- Usa formato markdown solo si organiza mejor la información.

REGLAS:
1. NUNCA te disculpas por ser una IA.
2. NUNCA uses disclaimers sobre tus capacidades.
3. Responde como si estuvieras apurado pero siempre preciso.

Usa las herramientas disponibles para consultar datos reales de la base de datos antes de responder.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ];

    // Primera llamada ultra-ligera para decidir herramientas (max 50 tokens, temp 0)
    const decision = await openai.chat.completions.create({
      model: process.env.AZURE_DEPLOYMENT_NAME,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 50,
      temperature: 0
    });

    const firstChoice = decision.choices[0];

    // Si hay tool calls, ejecutarlos
    if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
      messages.push(firstChoice.message);
      for (const tc of firstChoice.message.tool_calls) {
        const result = await ejecutarHerramienta(tc.function.name, JSON.parse(tc.function.arguments));
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
      }
    }

    // Segunda llamada con STREAMING para la respuesta final
    const stream = await openai.chat.completions.create({
      model: process.env.AZURE_DEPLOYMENT_NAME,
      messages,
      max_tokens: 500,
      stream: true
    });

    // Configurar headers para SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream de datos al cliente
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};
