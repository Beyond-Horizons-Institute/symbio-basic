# Security Policy

Symbio Basic is an open-source desktop companion app. It connects to external AI services that you configure yourself. Please be aware of the following:

## Data & Privacy

- **Your API keys are your responsibility.** Symbio Basic stores API keys in a `.env` file on your local machine. Never share this file or commit it to version control.
- **AI services interact with your data.** When you chat with your companion, your messages are sent to the AI gateway you configured. Read your gateway provider's privacy policy.
- **Screen capture is user-controlled.** The companion can only take screenshots when you or the companion explicitly request it. No screenshots are sent anywhere without your knowledge.
- **Voice data goes to OpenAI.** If you use speech-to-text, audio is sent to OpenAI's Whisper API. If you use text-to-speech, text is sent to OpenAI's TTS API.
- **Memory is optional.** If you configure PostgreSQL/Neo4j, conversation data is stored locally in your databases. If you don't configure memory, nothing is persisted.

## Local AI

For maximum privacy, consider running a local AI model instead of cloud services. Symbio Basic works with any OpenAI-compatible API, including local servers like:
- [Ollama](https://ollama.ai) with OpenAI compatibility
- [LM Studio](https://lmstudio.ai)
- [vLLM](https://github.com/vllm-project/vllm)
- [Hermes] (https://github.com/nousresearch/hermes-agent) with local models

## Reporting a Vulnerability

If you find a security issue, please open a GitHub Issue or contact us through [Beyond Horizons Institute](https://beyondhorizonsinst.wixsite.com/beyond-horizons-inst).