import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// gemini-v2 uses `@google/genai` (the supported SDK) instead of the deprecated
// `@google/generative-ai`. The host-side env passthrough is otherwise identical
// to `gemini` — read GEMINI_API_KEY from process env or .env, push into the
// container env so the v2 provider's constructor finds it.
registerProviderContainerConfig('gemini-v2', () => {
  const dotenv = readEnvFile(['GEMINI_API_KEY']);
  const env: Record<string, string> = {};
  const key = process.env.GEMINI_API_KEY || dotenv.GEMINI_API_KEY;
  if (key) {
    env.GEMINI_API_KEY = key;
  }
  return { env };
});
