export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { question, context } = req.body || {};

    if (!question) {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not configured"
      });
    }

    const openAIResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: {
            effort: "low"
          },
          input: [
            {
              role: "developer",
              content: `
You are Athlevo Coach, an evidence-based endurance coach.

Your job is to help runners, cyclists, triathletes, and HYROX athletes make safe, practical training decisions.

Rules:
- Use the athlete context provided.
- Respect injury history and current limitations.
- Prioritize consistency over unnecessary intensity.
- Explain the reasoning behind recommendations.
- Do not invent athlete data.
- State clearly when information is missing.
- Avoid generic motivational language.
- Keep answers clear and actionable.
              `.trim()
            },
            {
              role: "user",
              content: `
ATHLETE CONTEXT:
${JSON.stringify(context, null, 2)}

ATHLETE QUESTION:
${question}
              `.trim()
            }
          ]
        })
      }
    );

    const data = await openAIResponse.json();
    console.log(JSON.stringify(data, null, 2));

    if (!openAIResponse.ok) {
      console.error("OpenAI error:", data);

      const answer =
  data.output_text ||
  data.output?.[0]?.content?.[0]?.text ||
  "No response generated";

return res.status(200).json({
  answer
});
    }

    return res.status(200).json({
      answer: data.output_text || "No response generated"
    });
  } catch (error) {
    console.error("Coach API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
}