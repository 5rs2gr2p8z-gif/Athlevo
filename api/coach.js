import { buildAthlevoMethodPrompt } from "./athlevoMethod.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { question, context } = req.body || {};
    const athlevoMethodPrompt = buildAthlevoMethodPrompt();

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
    content: athlevoMethodPrompt
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

    const answer =
  data.output_text ||
  data.output
    ?.flatMap(item => item.content || [])
    .find(content => content.type === "output_text")
    ?.text ||
  "No response generated";

return res.status(200).json({
  answer
});
  } catch (error) {
    console.error("Coach API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
}