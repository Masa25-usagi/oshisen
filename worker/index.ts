/** Cloudflare Worker entry point for the vinext-starter template. */
import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createVoiceSession, voiceConfig } from "../lib/voice/server";

interface Env {
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  VOICE_ALLOWED_ORIGIN?: string;
  VOICE_DEMO_ACCESS_CODE?: string;
  VOICE_GEMINI_FREE_TIER?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Sites supplies runtime secrets as Worker bindings, never build-time values.
    const voiceEnv = {
      NODE_ENV: "production" as const,
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      VOICE_ALLOWED_ORIGIN: env.VOICE_ALLOWED_ORIGIN,
      VOICE_DEMO_ACCESS_CODE: env.VOICE_DEMO_ACCESS_CODE,
      VOICE_GEMINI_FREE_TIER: env.VOICE_GEMINI_FREE_TIER,
    };
    if (url.pathname === "/api/voice/config" && request.method === "GET") {
      return Response.json(voiceConfig(voiceEnv), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/api/voice/session" && request.method === "POST") {
      return createVoiceSession(request, voiceEnv);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
