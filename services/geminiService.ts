import { GoogleGenAI, Modality } from "@google/genai";
import { GeneratedImage } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

/**
 * Generates an image from a text prompt using the Gemini API.
 * @param prompt The text prompt to generate an image from.
 * @returns A promise that resolves to an object containing the base64 encoded image string and its mime type.
 */
export const generateImageFromText = async (prompt: string): Promise<GeneratedImage> => {
  try {
    const fullPrompt = `A cinematic, high-quality, visually appealing image that represents the following scene or dialogue: "${prompt}"`;
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: fullPrompt }],
      },
      config: {
        responseModalities: [Modality.IMAGE],
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return { base64Data: part.inlineData.data, mimeType: part.inlineData.mimeType };
      }
    }
    
    throw new Error("No image data was returned from the API.");

  } catch (error) {
    console.error("Error generating image with Gemini:", error);
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(`Failed to generate image: ${errorMessage}`);
  }
};
