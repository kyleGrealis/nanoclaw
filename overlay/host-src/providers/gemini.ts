import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Push GEMINI_API_KEY (from process env or .env) into the container env so
// the gemini provider's constructor finds it.
registerProviderContainerConfig('gemini', () => {
  const dotenv = readEnvFile(['GEMINI_API_KEY']);
  const env: Record<string, string> = {};
  const key = process.env.GEMINI_API_KEY || dotenv.GEMINI_API_KEY;
  if (key) {
    env.GEMINI_API_KEY = key;
  }
  return { env };
});
