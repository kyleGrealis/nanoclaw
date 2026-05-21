/**
 * Gemini provider container config.
 *
 * Injects GEMINI_API_KEY into the container environment.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('gemini', () => {
  const dotenv = readEnvFile(['GEMINI_API_KEY']);
  const env: Record<string, string> = {};
  if (dotenv.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = dotenv.GEMINI_API_KEY;
  }
  return { env };
});
