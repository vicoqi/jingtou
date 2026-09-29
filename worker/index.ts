/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleApiRequest, type ApiEnv } from "../lib/server.ts";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: ApiEnv['DB'];
  ASSETS_BUCKET: ApiEnv['ASSETS_BUCKET'];
  OPENAI_API_KEY?: string;
  IMAGE_API_KEY?: string;
  IMAGE_API_BASE_URL?: string;
  IMAGE_MODEL?: string;
  DASHSCOPE_API_KEY?: string;
  QWEN_TTS_MODEL?: string;
  QWEN_TTS_FEMALE_VOICE?: string;
  QWEN_TTS_MALE_VOICE?: string;
  STORYBOARD_LLM_MODEL?: string;
  STORYBOARD_LLM_BASE_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, { waitUntil: promise => ctx.waitUntil(promise) });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
