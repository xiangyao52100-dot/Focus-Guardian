import { GoogleGenAI, Type, Schema } from "@google/genai";
import { AnalysisResult, StudyStatus } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      enum: [StudyStatus.STUDYING, StudyStatus.DISTRACTED, StudyStatus.ABSENT],
      description: "The classification of the user's current behavior.",
    },
    reason: {
      type: Type.STRING,
      description: "A short, encouraging or warning message based on the behavior (max 10 words).",
    },
    confidence: {
      type: Type.NUMBER,
      description: "Confidence score between 0 and 1.",
    },
  },
  required: ["status", "reason", "confidence"],
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzeFrame = async (base64Image: string): Promise<AnalysisResult> => {
  const cleanBase64 = base64Image.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
  
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: cleanBase64,
              },
            },
            {
              text: `Analyze this webcam frame of a student. 
              Determine if they are:
              1. STUDYING (Looking at screen, reading book, writing, focused).
              2. DISTRACTED (Using phone, sleeping, playing with objects, looking around aimlessly).
              3. ABSENT (Empty chair, no person visible).
              
              Be strict about phone usage. If a phone is visible in hand, it is DISTRACTED.
              Return the result in JSON.`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          systemInstruction: "You are a strict but fair study supervisor.",
        },
      });

      let text = response.text;
      if (!text) throw new Error("No response from AI");

      // Clean Markdown code blocks if present (e.g., ```json ... ```)
      text = text.trim();
      if (text.startsWith("```json")) {
        text = text.replace(/^```json/, "").replace(/```$/, "");
      } else if (text.startsWith("```")) {
        text = text.replace(/^```/, "").replace(/```$/, "");
      }

      const result = JSON.parse(text) as AnalysisResult;
      return result;

    } catch (error: any) {
      // Check for 503 Service Unavailable or Overloaded errors
      // The error object structure might vary, so we check multiple properties
      const errorCode = error?.status || error?.code;
      const errorMessage = error?.message || "";
      const isOverloaded = errorCode === 503 || errorMessage.includes("overloaded") || errorMessage.includes("UNAVAILABLE");

      if (isOverloaded && attempt < MAX_RETRIES - 1) {
        attempt++;
        // Exponential backoff: 1s, 2s, 4s...
        const delay = 1000 * Math.pow(2, attempt - 1); 
        console.warn(`Gemini model overloaded. Retrying in ${delay}ms... (Attempt ${attempt}/${MAX_RETRIES})`);
        await wait(delay);
        continue;
      }

      console.error("Gemini Analysis Error:", error);
      // Fallback in case of error
      return {
        status: StudyStatus.IDLE,
        reason: isOverloaded ? "Server busy, retrying..." : "Analysis failed",
        confidence: 0,
      };
    }
  }

  return {
    status: StudyStatus.IDLE,
    reason: "Service unavailable",
    confidence: 0,
  };
};