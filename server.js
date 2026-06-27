import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;
// nanobanana = free-Pollen-friendly model that accepts multiple reference images.
// Swap to "kontext" (single image) or "flux" (text-only, no reference) if you want to try alternatives.
const MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "nanobanana";
const BASE_URL = "https://gen.pollinations.ai";

if (!POLLINATIONS_API_KEY) {
  console.warn("WARNING: POLLINATIONS_API_KEY is not set. Add it in Glitch's .env / Secrets.");
}

function sizeForAspectRatio(aspectRatio) {
  if (["2:3", "3:4", "9:16"].includes(aspectRatio)) return "1024x1536"; // portrait
  if (["4:3", "16:9"].includes(aspectRatio)) return "1536x1024"; // landscape
  return "1024x1024"; // 1:1 and fallback
}

function buildPrompt({
  category,
  productDetails,
  modelDetails,
  productScale,
  additionalContext,
  aspectRatio,
  lighting,
  scene,
  customScene,
}) {
  const lines = [
    `Create a professional, photorealistic ${category} product photograph suitable for Pinterest.`,
    customScene ? `Scene: ${customScene}` : `Scene: ${scene}.`,
    `Lighting: ${lighting}.`,
    `Aspect ratio target: ${aspectRatio}.`,
    productScale ? `Product scale reference: ${productScale}.` : null,
    productDetails ? `Product details: ${productDetails}.` : null,
    modelDetails ? `Model/influencer direction: ${modelDetails}.` : null,
    additionalContext ? `Additional context/props: ${additionalContext}.` : null,
    "Keep the actual product (and model, if provided) visually consistent with the reference images supplied. High production value, sharp focus, no text overlays, no watermarks.",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Calls Pollinations' OpenAI-compatible image edit/generate endpoints and
 * returns { mimeType, base64 }.
 */
async function generateOneImage({ prompt, referenceImages, size }) {
  if (referenceImages.length > 0) {
    const form = new FormData();
    form.append("model", MODEL);
    form.append("prompt", prompt);
    form.append("size", size);
    referenceImages.forEach((img, i) => {
      const buffer = Buffer.from(img.base64, "base64");
      const blob = new Blob([buffer], { type: img.mimeType || "image/png" });
      form.append("image", blob, `reference-${i}.png`); // repeated "image" field per Pollinations docs
    });

    const res = await fetch(`${BASE_URL}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pollinations error (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return { mimeType: "image/png", base64: data.data[0].b64_json };
  }

  // No reference images — plain text-to-image generation.
  const res = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${POLLINATIONS_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, prompt, size, n: 1, response_format: "b64_json" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pollinations error (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return { mimeType: "image/png", base64: data.data[0].b64_json };
}

app.post("/api/generate-images", async (req, res) => {
  try {
    if (!POLLINATIONS_API_KEY) {
      return res.status(500).json({ error: "Server is missing POLLINATIONS_API_KEY. Add it in Glitch Secrets." });
    }

    const {
      category,
      modelImage, // {mimeType, base64} | null
      modelDetails,
      productImages = [], // [{mimeType, base64} | null]
      productDetails,
      productScale,
      additionalContext,
      aspectRatio,
      lighting,
      customScene,
      scenes = [],
    } = req.body;

    const size = sizeForAspectRatio(aspectRatio);
    const referenceImages = [modelImage, ...productImages].filter(Boolean);
    const images = [];

    for (let i = 0; i < Math.max(scenes.length, 1); i++) {
      const scene = scenes[i];
      const prompt = buildPrompt({
        category, productDetails, modelDetails, productScale,
        additionalContext, aspectRatio, lighting, scene, customScene,
      });
      const img = await generateOneImage({ prompt, referenceImages, size });
      images.push({ scene: scene || customScene || `Photo ${i + 1}`, ...img });
      if (i < scenes.length - 1) await new Promise(r => setTimeout(r, 1200));
    }

    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EasyPin app listening on port ${PORT}`));
