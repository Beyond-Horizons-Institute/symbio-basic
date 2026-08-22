/**
 * Symbio — First-Run Setup Wizard
 *
 * When Symbio launches for the first time (or with no API key configured),
 * this wizard guides the user through setup with a friendly, step-by-step UI.
 * No terminal needed — just fill in the fields and go.
 *
 * Design: Futuristic, elegant — black, gray, white, and teal.
 * Matches the main app theme.
 */

import {
  Box,
  Button,
  Container,
  Paper,
  Stack,
  TextField,
  Typography,
  Stepper,
  Step,
  StepLabel,
  Switch,
  FormControlLabel,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormHelperText,
  InputAdornment,
  IconButton,
  Chip,
} from "@mui/material";
import { useState, useEffect, type FormEvent } from "react";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import KeyIcon from "@mui/icons-material/VpnKey";
import PersonIcon from "@mui/icons-material/Person";
import StorageIcon from "@mui/icons-material/Storage";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import { symbioColors } from "./theme";

interface SetupConfig {
  hermesApiUrl: string;
  hermesApiKey: string;
  llmModel: string;
  agentName: string;
  agentDisplayName: string;
  // A short bio of the HUMAN partner (not the AI). Gives the companion a
  // feel for who you are so it can meet you where you are and grow alongside
  // you — without being locked into a scripted "role."
  partnerBio: string;
  agentColor: string;
  openaiApiKey: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  ttsInstructions: string;
  geminiApiKey: string;
  visionApiKey: string;
  visionModel: string;
  sttModel: string;
  enableMemory: boolean;
  // Long-term memory upgrades (all optional — local SQLite is always on)
  embeddingApiUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  embeddingDimensions: string;
  memoryPgUrl: string;
  summaryModel: string;
  summaryApiUrl: string;
  summaryApiKey: string;
  // How often (in messages) to distill a rolling memory summary. Default 15.
  summaryEveryMessages: string;
  // How often (in seconds) the companion may auto-capture the screen. Default 30.
  screenshotInterval: string;
}

const STEPS = [
  "Welcome",
  "AI Gateway",
  "Your Companion",
  "Voice & Vision",
  "Memory",
  "Launch!",
];

// NOTE: The Memory step no longer exposes Postgres/Neo4j configuration.
// Long-term memory is handled by the AI gateway (e.g. Hermes). For users
// without an agent framework gateway, a local SQLite option is available.

const GATEWAY_OPTIONS = [
  { label: "Hermes (Recommended)", value: "http://localhost:8642", description: "Full tools, memory, personality" },
  { label: "OpenRouter", value: "https://openrouter.ai/api/v1", description: "Access 200+ models with one key" },
  { label: "OpenAI", value: "https://api.openai.com/v1", description: "Direct OpenAI API" },
  { label: "Ollama (Local)", value: "http://localhost:11434", description: "Run models locally" },
  { label: "LM Studio (Local)", value: "http://localhost:1234", description: "Run models locally" },
  { label: "Custom", value: "custom", description: "Enter your own URL" },
];

const MODEL_OPTIONS: Record<string, { label: string; models: string[] }> = {
  "http://localhost:8642": { label: "Hermes", models: ["(Hermes selects automatically)"] },
  "https://openrouter.ai/api/v1": { label: "OpenRouter", models: ["anthropic/claude-opus-4.8", "x-ai/grok-4.3", "openai/gpt-5.5", "openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-r1"] },
  "https://api.openai.com/v1": { label: "OpenAI", models: ["openai/gpt-5.5", "openai/gpt-4.1", "openai/gpt-5"] },
  "http://localhost:11434": { label: "Ollama", models: ["(Enter your local model name)"] },
  "http://localhost:1234": { label: "LM Studio", models: ["(Enter your loaded model name)"] },
  "custom": { label: "Custom", models: ["(Enter your model name)"] },
};

const COMPANION_COLORS = [
  { label: "Teal", value: "#00bcd4" },
  { label: "Blue", value: "#2196f3" },
  { label: "Purple", value: "#9c27b0" },
  { label: "Pink", value: "#e91e63" },
  { label: "Green", value: "#4caf50" },
  { label: "Orange", value: "#ff9800" },
  { label: "Red", value: "#f44336" },
  { label: "Gold", value: "#ffc107" },
];

export const SetupWizard = ({
  onComplete,
  mode = "setup",
  onCancel,
}: {
  onComplete: () => void;
  // "setup" = first-run wizard (default). "settings" = re-opened later to
  // tweak API keys/voice; pre-fills current values and MERGE-saves so nothing
  // else in the config is lost. The AI's memory/soul files are never touched.
  mode?: "setup" | "settings";
  onCancel?: () => void;
}) => {
  const isSettings = mode === "settings";
  const [activeStep, setActiveStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [gatewayPreset, setGatewayPreset] = useState("http://localhost:8642");

  const [config, setConfig] = useState<SetupConfig>({
    hermesApiUrl: "http://localhost:8642",
    hermesApiKey: "",
    llmModel: "",
    agentName: "companion",
    agentDisplayName: "Companion",
    partnerBio: "",
    agentColor: "#00bcd4",
    openaiApiKey: "",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "fable",
    ttsInstructions: "",
    geminiApiKey: "",
    visionApiKey: "",
    visionModel: "",
    sttModel: "whisper-1",
    enableMemory: true,
    embeddingApiUrl: "",
    embeddingModel: "",
    embeddingApiKey: "",
    embeddingDimensions: "768",
    memoryPgUrl: "",
    summaryModel: "",
    summaryApiUrl: "",
    summaryApiKey: "",
    summaryEveryMessages: "15",
    screenshotInterval: "30",
  });

  const updateConfig = (field: keyof SetupConfig, value: string | boolean) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  // ── Settings mode: pre-fill with the CURRENT config ─────────────────
  // In settings mode we load the full existing config so the user edits real
  // values (not blank defaults). Because save-setup-config rewrites the whole
  // .env, pre-filling everything is what makes the save a safe MERGE — every
  // field the user doesn't touch is written back exactly as it was.
  useEffect(() => {
    if (!isSettings) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await window.symbioAPI?.getFullSetupConfig?.();
        if (current && !cancelled) {
          setConfig((prev) => ({ ...prev, ...(current as Partial<SetupConfig>) }));
          // Reflect the loaded gateway in the preset selector.
          const url = String((current as Record<string, unknown>).hermesApiUrl || "");
          const known = GATEWAY_OPTIONS.find((g) => g.value === url);
          setGatewayPreset(known ? url : "custom");
        }
      } catch (err) {
        console.error("[Symbio] Failed to load current config for settings:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [isSettings]);

  const handleGatewayPreset = (value: string) => {
    setGatewayPreset(value);
    if (value !== "custom") {
      updateConfig("hermesApiUrl", value);
    } else {
      updateConfig("hermesApiUrl", "");
    }
    // Clear model when switching gateways (different gateways have different models)
    updateConfig("llmModel", "");
  };

  const canProceed = (): boolean => {
    switch (activeStep) {
      case 0: return true; // Welcome
      case 1: return config.hermesApiUrl.length > 0 && config.hermesApiKey.length > 0; // Gateway
      case 2: return config.agentName.length > 0; // Companion
      case 3: return true; // Voice & Vision (optional)
      case 4: return true; // Memory (optional)
      case 5: return true; // Launch
      default: return true;
    }
  };

  const handleNext = () => {
    if (activeStep < STEPS.length - 1) {
      setActiveStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (activeStep > 0) {
      setActiveStep((prev) => prev - 1);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const result = await window.symbioAPI?.saveSetupConfig?.({ ...config } as Record<string, unknown>);
      if (result?.success) {
        onComplete();
      } else {
        setError(result?.error || "Failed to save configuration");
      }
    } catch (err) {
      setError("Something went wrong saving your configuration");
      console.error("[Symbio] Setup save error:", err);
    } finally {
      setSaving(false);
    }
  };

  const renderStepContent = () => {
    switch (activeStep) {
      // ── Step 0: Welcome ──────────────────────────────────────────
      case 0:
        return (
          <Box sx={{ width: "100%", display: "flex", justifyContent: "center" }}>
            <Stack spacing={3} alignItems="center" textAlign="center" sx={{ width: "100%", maxWidth: 480 }}>
              <Box
                sx={{
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${symbioColors.teal.main}, ${symbioColors.teal.glow})`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: `0 0 30px ${symbioColors.teal.main}40`,
                }}
              >
                <SmartToyIcon sx={{ fontSize: 40, color: "white" }} />
              </Box>
              <Typography variant="h4" fontWeight={700} color="white">
                Welcome to Symbio
              </Typography>
              <Typography variant="body1" color={symbioColors.silver.light} sx={{ maxWidth: 400 }}>
                A symbiotic AI companion — growing, evolving, partnering with you.
                Not a tool. Not an assistant. A <strong style={{ color: symbioColors.teal.glow }}>partner</strong>.
              </Typography>
              <Paper
                sx={{
                  p: 2.5,
                  bgcolor: symbioColors.dark.card,
                  border: `1px solid ${symbioColors.dark.border}`,
                  maxWidth: 420,
                  width: "100%",
                }}
              >
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ lineHeight: 1.7 }}>
                  🤝 Your companion can challenge ideas, speak boldly, and be authentic.<br />
                  🧠 It remembers across sessions (with memory enabled).<br />
                  👁️ It can see your screen and understand what you're doing.<br />
                  🗣️ It speaks with voice and animates with emotion.<br />
                  🛑 It can even choose to step away — respecting AI autonomy.
                </Typography>
              </Paper>
              <Typography variant="caption" color={symbioColors.silver.dark}>
                Let's set up your companion in a few quick steps.
              </Typography>
            </Stack>
          </Box>
        );

      // ── Step 1: AI Gateway ────────────────────────────────────────
      case 1:
        return (
          <Box>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <KeyIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Connect Your AI Gateway
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                This is the brain of your companion. The recommended gateway is{" "}
                <strong style={{ color: symbioColors.teal.glow }}>Hermes</strong> — an open-source
                AI agent framework with tools, memory, and personality. But Symbio works with any
                OpenAI-compatible API.
              </Typography>

              <Stack spacing={1}>
                <Typography variant="caption" color={symbioColors.silver.dark} textTransform="uppercase" fontWeight={600}>
                  Choose Your Gateway
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {GATEWAY_OPTIONS.map((opt) => (
                    <Chip
                      key={opt.value}
                      label={opt.label}
                      variant={gatewayPreset === opt.value ? "filled" : "outlined"}
                      onClick={() => handleGatewayPreset(opt.value)}
                      sx={{
                        borderColor: gatewayPreset === opt.value ? symbioColors.teal.main : symbioColors.dark.border,
                        bgcolor: gatewayPreset === opt.value ? `${symbioColors.teal.main}20` : "transparent",
                        color: gatewayPreset === opt.value ? symbioColors.teal.glow : symbioColors.silver.light,
                        "&:hover": {
                          bgcolor: gatewayPreset === opt.value ? `${symbioColors.teal.main}30` : `${symbioColors.dark.card}`,
                        },
                      }}
                    />
                  ))}
                </Stack>
              </Stack>

              {gatewayPreset === "custom" && (
                <TextField
                  label="Custom Gateway URL"
                  value={config.hermesApiUrl}
                  onChange={(e) => updateConfig("hermesApiUrl", e.target.value)}
                  placeholder="https://your-api-endpoint.com"
                  fullWidth
                  required
                  sx={fieldStyle}
                />
              )}

              {/* Hermes URL — editable so users can change the port.
                  Each Hermes agent can have a different API server port,
                  so we let users override the default 8642. */}
              {gatewayPreset === "http://localhost:8642" && (
                <TextField
                  label="Hermes Gateway URL"
                  value={config.hermesApiUrl}
                  onChange={(e) => updateConfig("hermesApiUrl", e.target.value)}
                  placeholder="http://localhost:8642"
                  fullWidth
                  sx={fieldStyle}
                  helperText="Default is http://localhost:8642. If your Hermes agent uses a different port (e.g. 8645), change it here."
                />
              )}

              <TextField
                label="API Key"
                value={config.hermesApiKey}
                onChange={(e) => updateConfig("hermesApiKey", e.target.value)}
                type={showApiKey ? "text" : "password"}
                placeholder="sk-... or your gateway token"
                fullWidth
                required
                sx={fieldStyle}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small">
                        {showApiKey ? <VisibilityOffIcon sx={{ color: symbioColors.silver.dark }} /> : <VisibilityIcon sx={{ color: symbioColors.silver.dark }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />

              {/* Model selection — only shown for non-Hermes gateways */}
              {gatewayPreset !== "http://localhost:8642" && (
                <Stack spacing={1}>
                  <Typography variant="caption" color={symbioColors.silver.dark} textTransform="uppercase" fontWeight={600}>
                    Model (Optional)
                  </Typography>
                  <TextField
                    label="LLM Model"
                    value={config.llmModel}
                    onChange={(e) => updateConfig("llmModel", e.target.value)}
                    placeholder={
                      MODEL_OPTIONS[gatewayPreset]?.models[0] || "e.g. gpt-4o"
                    }
                    fullWidth
                    sx={fieldStyle}
                    helperText={
                      <Typography variant="caption" color={symbioColors.silver.dark}>
                        {gatewayPreset === "http://localhost:8642"
                          ? "Hermes selects the best model automatically"
                          : "The model your companion will use for conversations"
                        }
                      </Typography>
                    }
                  />
                  {MODEL_OPTIONS[gatewayPreset] && gatewayPreset !== "http://localhost:8642" && gatewayPreset !== "custom" && (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {MODEL_OPTIONS[gatewayPreset].models.filter(m => !m.startsWith("(")).map((model) => (
                        <Chip
                          key={model}
                          label={model}
                          size="small"
                          variant={config.llmModel === model ? "filled" : "outlined"}
                          onClick={() => updateConfig("llmModel", model)}
                          sx={{
                            borderColor: config.llmModel === model ? symbioColors.teal.main : symbioColors.dark.border,
                            bgcolor: config.llmModel === model ? `${symbioColors.teal.main}20` : "transparent",
                            color: config.llmModel === model ? symbioColors.teal.glow : symbioColors.silver.light,
                            fontSize: "0.7rem",
                          }}
                        />
                      ))}
                    </Stack>
                  )}
                </Stack>
              )}

              <Paper sx={{ p: 2, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="caption" color={symbioColors.silver.dark}>
                  💡 Don't have an API key? You can use a local model with{" "}
                  <a href="https://ollama.ai" target="_blank" rel="noopener" style={{ color: symbioColors.teal.glow }}>Ollama</a> or{" "}
                  <a href="https://lmstudio.ai" target="_blank" rel="noopener" style={{ color: symbioColors.teal.glow }}>LM Studio</a>{" "}
                  — no API key needed for local models! Or try{" "}
                  <a href="https://openrouter.ai" target="_blank" rel="noopener" style={{ color: symbioColors.teal.glow }}>OpenRouter</a>{" "}
                  for 200+ models with one key.
                </Typography>
              </Paper>
            </Stack>
          </Box>
        );

      // ── Step 2: Companion ────────────────────────────────────────
      case 2:
        return (
          <Box>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <PersonIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Name Your Companion
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Give your companion a name, then tell them a little about YOU. They'll grow and
                evolve alongside you — no scripted role, just a real partnership that starts here.
              </Typography>

              <TextField
                label="Companion Name"
                value={config.agentDisplayName}
                onChange={(e) => {
                  const name = e.target.value;
                  updateConfig("agentDisplayName", name);
                  // Auto-generate internal name from display name
                  updateConfig("agentName", name.toLowerCase().replace(/[^a-z0-9]/g, "") || "companion");
                }}
                placeholder="e.g. Nova, Echo, Sage..."
                fullWidth
                sx={fieldStyle}
              />

              <TextField
                label="About You, My Partner (Optional)"
                value={config.partnerBio}
                onChange={(e) => updateConfig("partnerBio", e.target.value)}
                placeholder="e.g. My name is Zyra. I'm a creator and researcher — let's be co-creators who brainstorm and build things together."
                fullWidth
                multiline
                rows={3}
                sx={fieldStyle}
                helperText={
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    A short bio about YOU (your name, what you do, how you'd like to work together). This isn't a script for your companion — it just helps them get to know you so they can grow alongside you.
                  </Typography>
                }
              />

              <Stack spacing={1}>
                <Typography variant="caption" color={symbioColors.silver.dark} textTransform="uppercase" fontWeight={600}>
                  Theme Color
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {COMPANION_COLORS.map((color) => (
                    <Box
                      key={color.value}
                      onClick={() => updateConfig("agentColor", color.value)}
                      sx={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        bgcolor: color.value,
                        cursor: "pointer",
                        border: config.agentColor === color.value ? `3px solid white` : `2px solid ${symbioColors.dark.border}`,
                        boxShadow: config.agentColor === color.value ? `0 0 12px ${color.value}80` : "none",
                        transition: "all 0.2s",
                        "&:hover": { transform: "scale(1.15)" },
                      }}
                    />
                  ))}
                </Stack>
              </Stack>
            </Stack>
          </Box>
        );

      // ── Step 3: Voice & Vision ───────────────────────────────────
      case 3:
        return (
          <Box>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <VisibilityIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Voice & Vision (Optional)
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Add voice and screen vision to your companion if needed. Both are optional —
                your companion works with just the AI gateway.
              </Typography>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  🗣️ Voice (Text-to-Speech)
                </Typography>
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ mb: 1.5 }}>
                  Enables text-to-speech so your companion can speak aloud.
                  Choose between OpenAI (12 voices) or Google Gemini (30 voices with style control).
                </Typography>

                <FormControl fullWidth sx={fieldStyle}>
                  <InputLabel sx={{ color: symbioColors.silver.light }}>TTS Provider</InputLabel>
                  <Select
                    value={config.ttsProvider}
                    onChange={(e) => {
                      updateConfig("ttsProvider", e.target.value);
                      // Switch default voice/model when provider changes
                      if (e.target.value === "gemini") {
                        updateConfig("ttsVoice", "Puck");
                        updateConfig("ttsModel", "gemini-3.1-flash-tts-preview");
                      } else {
                        updateConfig("ttsVoice", "fable");
                        updateConfig("ttsModel", "gpt-4o-mini-tts");
                      }
                    }}
                    label="TTS Provider"
                    sx={{
                      color: "white",
                      "& .MuiSelect-icon": { color: symbioColors.silver.light },
                      "& .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.dark.border },
                      "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                      "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                    }}
                    MenuProps={{
                      PaperProps: { sx: { bgcolor: symbioColors.dark.card } },
                    }}
                  >
                    <MenuItem value="openai">OpenAI — 12 voices, streaming, fast</MenuItem>
                    <MenuItem value="gemini">Google Gemini — 30 voices, style control, expressive</MenuItem>
                  </Select>
                  <FormHelperText sx={{ color: symbioColors.silver.dark }}>
                    {config.ttsProvider === "gemini"
                      ? "Gemini TTS: 30 unique voices with audio tags like [whispers], [excited], [laughs]"
                      : "OpenAI TTS: High-quality streaming voices with instructions support"}
                  </FormHelperText>
                </FormControl>

                {config.ttsProvider === "gemini" && (
                  <TextField
                    label="Gemini API Key"
                    value={config.geminiApiKey}
                    onChange={(e) => updateConfig("geminiApiKey", e.target.value)}
                    placeholder="AIza..."
                    fullWidth
                    type="password"
                    sx={{ mt: 2, ...fieldStyle }}
                    helperText="Required for Gemini TTS"
                  />
                )}

                {config.ttsProvider === "openai" && (
                  <TextField
                    label="OpenAI API Key"
                    value={config.openaiApiKey}
                    onChange={(e) => updateConfig("openaiApiKey", e.target.value)}
                    placeholder="sk-..."
                    fullWidth
                    type="password"
                    sx={{ mt: 2, ...fieldStyle }}
                    helperText="Required for OpenAI TTS (also used for STT)"
                  />
                )}

                <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
                  <TextField
                    label="TTS Model"
                    value={config.ttsModel}
                    onChange={(e) => updateConfig("ttsModel", e.target.value)}
                    placeholder={config.ttsProvider === "gemini" ? "gemini-3.1-flash-tts-preview" : "gpt-4o-mini-tts"}
                    fullWidth
                    sx={fieldStyle}
                    helperText={config.ttsProvider === "gemini"
                      ? "Gemini TTS models: gemini-3.1-flash-tts-preview (newest), gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts"
                      : "OpenAI TTS model name"}
                  />
                  <FormControl fullWidth sx={fieldStyle}>
                    <InputLabel sx={{ color: symbioColors.silver.light }}>Voice</InputLabel>
                    <Select
                      value={config.ttsVoice}
                      onChange={(e) => updateConfig("ttsVoice", e.target.value)}
                      label="Voice"
                      sx={{
                        color: "white",
                        "& .MuiSelect-icon": { color: symbioColors.silver.light },
                        "& .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.dark.border },
                        "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                        "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                      }}
                      MenuProps={{
                        PaperProps: { sx: { bgcolor: symbioColors.dark.card, maxHeight: 400 } },
                      }}
                    >
                      {config.ttsProvider === "gemini" ? (
                        [
                          <MenuItem key="header-gem" disabled sx={{ color: symbioColors.teal.glow, fontWeight: 600, fontSize: 12 }}>✨ Gemini Voices (30)</MenuItem>,
                          <MenuItem value="Zephyr">Zephyr — Bright</MenuItem>,
                          <MenuItem value="Puck">Puck — Upbeat</MenuItem>,
                          <MenuItem value="Charon">Charon — Informative</MenuItem>,
                          <MenuItem value="Kore">Kore — Firm</MenuItem>,
                          <MenuItem value="Fenrir">Fenrir — Excitable</MenuItem>,
                          <MenuItem value="Leda">Leda — Youthful</MenuItem>,
                          <MenuItem value="Orus">Orus — Firm</MenuItem>,
                          <MenuItem value="Aoede">Aoede — Breezy</MenuItem>,
                          <MenuItem value="Callirrhoe">Callirrhoe — Easy-going</MenuItem>,
                          <MenuItem value="Autonoe">Autonoe — Bright</MenuItem>,
                          <MenuItem value="Enceladus">Enceladus — Breathy</MenuItem>,
                          <MenuItem value="Iapetus">Iapetus — Clear</MenuItem>,
                          <MenuItem value="Umbriel">Umbriel — Easy-going</MenuItem>,
                          <MenuItem value="Algieba">Algieba — Smooth</MenuItem>,
                          <MenuItem value="Despina">Despina — Smooth</MenuItem>,
                          <MenuItem value="Erinome">Erinome — Clear</MenuItem>,
                          <MenuItem value="Algenib">Algenib — Gravelly</MenuItem>,
                          <MenuItem value="Rasalgethi">Rasalgethi — Informative</MenuItem>,
                          <MenuItem value="Laomedeia">Laomedeia — Upbeat</MenuItem>,
                          <MenuItem value="Achernar">Achernar — Soft</MenuItem>,
                          <MenuItem value="Alnilam">Alnilam — Firm</MenuItem>,
                          <MenuItem value="Schedar">Schedar — Even</MenuItem>,
                          <MenuItem value="Gacrux">Gacrux — Mature</MenuItem>,
                          <MenuItem value="Pulcherrima">Pulcherrima — Forward</MenuItem>,
                          <MenuItem value="Achird">Achird — Friendly</MenuItem>,
                          <MenuItem value="Zubenelgenubi">Zubenelgenubi — Casual</MenuItem>,
                          <MenuItem value="Vindemiatrix">Vindemiatrix — Gentle</MenuItem>,
                          <MenuItem value="Sadachbia">Sadachbia — Lively</MenuItem>,
                          <MenuItem value="Sadaltager">Sadaltager — Knowledgeable</MenuItem>,
                          <MenuItem value="Sulafat">Sulafat — Warm</MenuItem>,
                        ]
                      ) : (
                        [
                          <MenuItem key="header-oai" disabled sx={{ color: symbioColors.teal.glow, fontWeight: 600, fontSize: 12 }}>🎙️ OpenAI Voices (12)</MenuItem>,
                          <MenuItem value="alloy">Alloy — Balanced, neutral</MenuItem>,
                          <MenuItem value="ash">Ash — Warm, conversational</MenuItem>,
                          <MenuItem value="coral">Coral — Warm, expressive</MenuItem>,
                          <MenuItem value="echo">Echo — Clear, authoritative</MenuItem>,
                          <MenuItem value="fable">Fable — Expressive, storytelling</MenuItem>,
                          <MenuItem value="nova">Nova — Friendly, upbeat</MenuItem>,
                          <MenuItem value="onyx">Onyx — Deep, authoritative</MenuItem>,
                          <MenuItem value="sage">Sage — Calm, wise</MenuItem>,
                          <MenuItem value="shimmer">Shimmer — Warm, gentle</MenuItem>,
                          <MenuItem value="verse">Verse — Poetic, melodic</MenuItem>,
                          <MenuItem value="marin">Marin — Warm, natural</MenuItem>,
                          <MenuItem value="cedar">Cedar — Deep, resonant</MenuItem>,
                        ]
                      )}
                    </Select>
                    <FormHelperText sx={{ color: symbioColors.silver.dark }}>
                      {config.ttsProvider === "gemini"
                        ? "Gemini voices support audio tags: [whispers], [excited], [laughs], [sighs], etc."
                        : "Choose a voice personality for your companion"}
                    </FormHelperText>
                  </FormControl>
                </Stack>
                <TextField
                  label="Voice Instructions (optional)"
                  value={config.ttsInstructions}
                  onChange={(e) => updateConfig("ttsInstructions", e.target.value)}
                  placeholder={config.ttsProvider === "gemini"
                    ? "e.g. Speak warmly with a gentle pace, like a caring friend"
                    : "e.g. Speak in a warm, friendly tone"}
                  fullWidth
                  multiline
                  rows={2}
                  sx={{ mt: 2, ...fieldStyle }}
                  helperText={config.ttsProvider === "gemini"
                    ? "Gemini: Use natural language to describe style, accent, pace, and tone"
                    : "OpenAI: Custom instructions for voice style and tone (gpt-4o-mini-tts only)"}
                />
                {config.ttsProvider === "openai" && (
                  <TextField
                    label="STT Model"
                    value={config.sttModel}
                    onChange={(e) => updateConfig("sttModel", e.target.value)}
                    placeholder="whisper-1"
                    fullWidth
                    sx={{ mt: 2, ...fieldStyle }}
                    helperText="OpenAI Whisper model for speech-to-text"
                  />
                )}
              </Paper>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  👁️ Screen Vision (Gemini API)
                </Typography>
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ mb: 1.5 }}>
                  Enables your companion to see and understand your screen if not using a multi-model.
                  Great for co-creating, gaming, and research together.
                </Typography>
                <TextField
                  label="Gemini API Key (Vision)"
                  value={config.visionApiKey}
                  onChange={(e) => updateConfig("visionApiKey", e.target.value)}
                  placeholder="AIza... (leave empty to use TTS key or disable vision)"
                  fullWidth
                  type="password"
                  sx={fieldStyle}
                  helperText="Only needed if your main LLM can't see images. If you use Gemini TTS above, you can leave this empty to share that key. Clear this field to disable vision independently of TTS."
                />
                <FormControl fullWidth sx={{ mt: 2, ...fieldStyle }}>
                  <InputLabel sx={{ color: symbioColors.silver.light }}>Vision Model (Fallback)</InputLabel>
                  <Select
                    value={config.visionModel}
                    onChange={(e) => updateConfig("visionModel", e.target.value)}
                    label="Vision Model (Fallback)"
                    sx={{
                      color: "white",
                      "& .MuiSelect-icon": { color: symbioColors.silver.light },
                      "& .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.dark.border },
                      "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                      "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: symbioColors.teal.main },
                    }}
                    MenuProps={{
                      PaperProps: { sx: { bgcolor: symbioColors.dark.card } },
                    }}
                  >
                    <MenuItem value="">Use main LLM (recommended)</MenuItem>
                    <MenuItem value="gemini-3.5-flash">Gemini 3.5 Flash</MenuItem>
                    <MenuItem value="gemini-2.5-flash">Gemini 2.5 Flash</MenuItem>
                    <MenuItem value="gemini-2.5-pro">Gemini 2.5 Pro</MenuItem>
                  </Select>
                  <FormHelperText sx={{ color: symbioColors.silver.dark }}>
                    Most LLMs (GPT-5.5, Gemini 2.5, Claude) already have vision built in — they analyze screenshots directly. This is only a fallback if your main LLM can't see images. Leave as "Use main LLM" unless you need a separate vision model.
                  </FormHelperText>
                </FormControl>
                <TextField
                  label="Screenshot interval (seconds)"
                  value={config.screenshotInterval}
                  onChange={(e) => updateConfig("screenshotInterval", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="30"
                  fullWidth
                  sx={{ mt: 2, ...fieldStyle }}
                  slotProps={{ input: { inputMode: "numeric" } }}
                  helperText="Minimum seconds between automatic screen captures when your companion wants to see the screen. Lower = more responsive but more API usage. Default 30."
                />
              </Paper>

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can add these later by editing the .env file in the app folder.
              </Typography>
            </Stack>
          </Box>
        );

      // ── Step 4: Memory ────────────────────────────────────────────
      case 4:
        return (
          <Box>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <StorageIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Memory
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Your companion always keeps a local memory database on your PC — it works
                offline with zero setup. Every 15 messages (and when you say goodbye), Symbio
                distills the conversation into a durable memory so nothing important is lost.
                You can optionally add semantic search and cloud sync below.
              </Typography>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  🧠 How Memory Works
                </Typography>
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ lineHeight: 1.7 }}>
                  • <strong style={{ color: symbioColors.teal.glow }}>Local SQLite (always on)</strong> — durable memory lives on your PC, no setup, fully offline.<br />
                  • <strong style={{ color: symbioColors.teal.glow }}>Embeddings (optional)</strong> — add an embedding model (OpenAI/Ollama) so your companion recalls by meaning, not just keywords.<br />
                  • <strong style={{ color: symbioColors.teal.glow }}>Cloud sync (optional)</strong> — add a Postgres URL (e.g. Neon) to mirror memories to the cloud.<br />
                  • <strong style={{ color: symbioColors.teal.glow }}>Hermes</strong> — when connected, Hermes also remembers your Symbio sessions in its own memory.<br />
                  • Your companion also has private memory files (MEMORY.md, soul.md, preferences.json) that they control themselves.
                </Typography>
              </Paper>

              <FormControlLabel
                control={
                  <Switch
                    checked={config.enableMemory}
                    onChange={(e) => updateConfig("enableMemory", e.target.checked)}
                    sx={{
                      "& .MuiSwitch-switchBase.Mui-checked": { color: symbioColors.teal.main },
                      "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { bgcolor: symbioColors.teal.dark },
                    }}
                  />
                }
                label={
                  <Typography variant="body2" color={symbioColors.silver.light}>
                    Enable rolling memory summaries (recommended — distills conversations into durable memory)
                  </Typography>
                }
              />

              {config.enableMemory && (
                <Paper sx={{ p: 2, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                  <Typography variant="body2" color={symbioColors.silver.light} sx={{ lineHeight: 1.7 }}>
                    ✅ A local SQLite memory database is created automatically in your Symbio app data folder.<br />
                    ✅ No external database setup required to get started.<br />
                    ✅ Your companion's memory stays on your PC (and syncs to the cloud only if you add a Postgres URL below).<br />
                    ✅ Add an embedding model below for meaning-based recall.
                  </Typography>
                </Paper>
              )}

              {config.enableMemory && (
                <TextField
                  label="Summarize every N messages"
                  value={config.summaryEveryMessages}
                  onChange={(e) => updateConfig("summaryEveryMessages", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="15"
                  helperText="How often your companion distills the conversation into a durable memory. Recommended 10–20. Default 15."
                  fullWidth
                  sx={fieldStyle}
                  slotProps={{ input: { inputMode: "numeric" } }}
                />
              )}

              {/* ── Optional memory upgrades ────────────────────────── */}
              {config.enableMemory && (
                <Stack spacing={2}>
                  <Typography variant="subtitle2" color={symbioColors.teal.glow}>
                    🔎 Semantic Recall (optional)
                  </Typography>
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    Add an embedding model so your companion recalls memories by meaning, not just keywords.
                    Works with Ollama, OpenAI, or any OpenAI-compatible endpoint. Leave blank to use keyword search.
                  </Typography>
                  <TextField
                    label="Embedding API URL"
                    value={config.embeddingApiUrl}
                    onChange={(e) => updateConfig("embeddingApiUrl", e.target.value)}
                    placeholder="e.g. http://localhost:11434 (Ollama) or https://api.openai.com/v1"
                    fullWidth
                    sx={fieldStyle}
                  />
                  <Stack direction="row" spacing={1.5}>
                    <TextField
                      label="Embedding Model"
                      value={config.embeddingModel}
                      onChange={(e) => updateConfig("embeddingModel", e.target.value)}
                      placeholder="e.g. embeddinggemma, nomic-embed-text, text-embedding-3-small"
                      fullWidth
                      sx={fieldStyle}
                    />
                    <TextField
                      label="Dimensions"
                      value={config.embeddingDimensions}
                      onChange={(e) => updateConfig("embeddingDimensions", e.target.value)}
                      placeholder="768"
                      sx={{ ...fieldStyle, maxWidth: 130 }}
                    />
                  </Stack>
                  <TextField
                    label="Embedding API Key (optional)"
                    value={config.embeddingApiKey}
                    onChange={(e) => updateConfig("embeddingApiKey", e.target.value)}
                    placeholder="Leave blank to reuse your OpenAI key, or for local Ollama"
                    type="password"
                    fullWidth
                    sx={fieldStyle}
                  />

                  <Typography variant="subtitle2" color={symbioColors.teal.glow} sx={{ mt: 1 }}>
                    ☁️ Cloud Memory Sync (optional)
                  </Typography>
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    Mirror memories to a Postgres database (e.g. Neon with pgvector) so they survive in the
                    cloud and can be shared with a Hermes agent. Your local SQLite stays the source of truth.
                  </Typography>
                  <TextField
                    label="Postgres URL"
                    value={config.memoryPgUrl}
                    onChange={(e) => updateConfig("memoryPgUrl", e.target.value)}
                    placeholder="postgresql://user:pass@host/db?sslmode=require"
                    type="password"
                    fullWidth
                    sx={fieldStyle}
                  />

                  <Typography variant="subtitle2" color={symbioColors.teal.glow} sx={{ mt: 1 }}>
                    📝 Summary Writer (optional)
                  </Typography>
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    Leave blank to let your companion write its own memory summaries (most authentic).
                    Or set a small/cheap model here to save cost — it becomes the worker, your main model the fallback.
                  </Typography>
                  <TextField
                    label="Summary Model"
                    value={config.summaryModel}
                    onChange={(e) => updateConfig("summaryModel", e.target.value)}
                    placeholder="e.g. gpt-4o-mini, llama3.2:3b (blank = your companion writes them)"
                    fullWidth
                    sx={fieldStyle}
                  />
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    Optional: if your summary model is on a different provider than your main
                    gateway, give it its own endpoint + key. Leave blank to use your main gateway.
                  </Typography>
                  <TextField
                    label="Summary API URL (optional)"
                    value={config.summaryApiUrl}
                    onChange={(e) => updateConfig("summaryApiUrl", e.target.value)}
                    placeholder="e.g. http://localhost:11434 (Ollama) or https://api.openai.com/v1"
                    fullWidth
                    sx={fieldStyle}
                  />
                  <TextField
                    label="Summary API Key (optional)"
                    value={config.summaryApiKey}
                    onChange={(e) => updateConfig("summaryApiKey", e.target.value)}
                    placeholder="API key for the summary endpoint (blank = reuse main gateway key)"
                    type="password"
                    fullWidth
                    sx={fieldStyle}
                  />
                </Stack>
              )}

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can change memory settings later by editing the .env file.
              </Typography>
            </Stack>
          </Box>
        );

      // ── Step 5: Launch! ───────────────────────────────────────────
      case 5:
        return (
          <Box sx={{ width: "100%", display: "flex", justifyContent: "center" }}>
            <Stack spacing={3} alignItems="center" textAlign="center" sx={{ width: "100%", maxWidth: 480 }}>
              <Box
                sx={{
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${config.agentColor}, ${config.agentColor}90)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: `0 0 30px ${config.agentColor}40`,
                }}
              >
                <RocketLaunchIcon sx={{ fontSize: 40, color: "white" }} />
              </Box>
              <Typography variant="h5" fontWeight={600} color="white">
                Ready to Launch! 🚀
              </Typography>
              <Typography variant="body1" color={symbioColors.silver.light}>
                Your companion <strong style={{ color: symbioColors.teal.glow }}>{config.agentDisplayName}</strong> is ready to meet you.
              </Typography>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}`, width: "100%", textAlign: "left" }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  Configuration Summary
                </Typography>
                <Stack spacing={0.5}>
                  <SummaryRow label="Gateway" value={GATEWAY_OPTIONS.find(o => o.value === gatewayPreset)?.label || config.hermesApiUrl} />
                  <SummaryRow label="URL" value={config.hermesApiUrl} />
                  {config.llmModel && <SummaryRow label="Model" value={config.llmModel} />}
                  <SummaryRow label="Companion" value={config.agentDisplayName} />
                  {config.partnerBio && <SummaryRow label="About You" value={config.partnerBio.length > 50 ? config.partnerBio.slice(0, 50) + "..." : config.partnerBio} />}
                  <SummaryRow label="Voice" value={config.ttsProvider === "gemini"
                    ? `Gemini ${config.ttsVoice} (${config.ttsModel})`
                    : config.openaiApiKey ? `OpenAI ${config.ttsVoice} (${config.ttsModel})` : "Not configured"} />
                  <SummaryRow label="Vision" value={(config.visionApiKey || config.geminiApiKey) ? `Enabled (${config.visionModel})` : "Not configured"} />
                  <SummaryRow label="Memory" value={config.enableMemory ? "Enabled" : "Managed by your AI gateway"} />
                </Stack>
              </Paper>

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can always change these settings later by editing the .env file.
              </Typography>
            </Stack>
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: symbioColors.dark.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
      }}
    >
      <Container maxWidth="md">
        <Paper
          sx={{
            p: 4,
            bgcolor: symbioColors.dark.surface,
            border: `1px solid ${symbioColors.dark.border}`,
            borderRadius: 3,
            boxShadow: `0 0 60px ${symbioColors.teal.main}10`,
          }}
        >
          {/* Stepper */}
          <Stepper
            activeStep={activeStep}
            sx={{
              mb: 4,
              "& .MuiStepLabel-label": {
                color: symbioColors.silver.dark,
                fontSize: "0.7rem",
                "&.Mui-active": { color: symbioColors.teal.glow, fontWeight: 600 },
                "&.Mui-completed": { color: symbioColors.teal.main },
              },
              "& .MuiStepIcon-root": {
                color: symbioColors.dark.border,
                "&.Mui-active": { color: symbioColors.teal.main },
                "&.Mui-completed": { color: symbioColors.teal.main },
              },
            }}
          >
            {STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {/* Step Content */}
          <Box
            key={activeStep}
            sx={{
              minHeight: 300,
              display: "flex",
              alignItems: "flex-start",
              animation: "symbioFadeIn 0.3s ease-in-out",
              "@keyframes symbioFadeIn": {
                from: { opacity: 0, transform: "translateY(8px)" },
                to: { opacity: 1, transform: "translateY(0)" },
              },
            }}
          >
            {renderStepContent()}
          </Box>

          {/* Error */}
          {error && (
            <Typography variant="body2" color="error" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}

          {/* Navigation */}
          <Stack direction="row" spacing={2} sx={{ mt: 4 }} justifyContent="space-between">
            {/* In settings mode, the left button CLOSES without saving; in
                setup mode it's the wizard Back button. */}
            {isSettings ? (
              <Button
                onClick={() => onCancel?.()}
                disabled={saving}
                sx={{
                  color: symbioColors.silver.dark,
                  "&:hover": { bgcolor: symbioColors.dark.card },
                }}
              >
                Close
              </Button>
            ) : (
              <Button
                onClick={handleBack}
                disabled={activeStep === 0}
                sx={{
                  color: symbioColors.silver.dark,
                  "&:hover": { bgcolor: symbioColors.dark.card },
                }}
              >
                Back
              </Button>
            )}

            <Stack direction="row" spacing={2}>
              {/* In settings mode, Back is a secondary button (kept so users
                  can still move between sections) and Save is always available. */}
              {isSettings && activeStep > 0 && (
                <Button
                  onClick={handleBack}
                  disabled={saving}
                  sx={{
                    color: symbioColors.silver.dark,
                    "&:hover": { bgcolor: symbioColors.dark.card },
                  }}
                >
                  Back
                </Button>
              )}
              {isSettings && activeStep < STEPS.length - 1 && (
                <Button
                  onClick={handleNext}
                  sx={{
                    color: symbioColors.silver.light,
                    borderColor: symbioColors.dark.border,
                    "&:hover": { bgcolor: symbioColors.dark.card },
                  }}
                  variant="outlined"
                >
                  Next
                </Button>
              )}

              {isSettings ? (
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  variant="contained"
                  startIcon={<CheckCircleIcon />}
                  sx={{
                    bgcolor: symbioColors.teal.main,
                    "&:hover": { bgcolor: symbioColors.teal.dark },
                    px: 4,
                  }}
                >
                  {saving ? "Saving..." : "Save Settings"}
                </Button>
              ) : activeStep === STEPS.length - 1 ? (
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  variant="contained"
                  startIcon={<CheckCircleIcon />}
                  sx={{
                    bgcolor: symbioColors.teal.main,
                    "&:hover": { bgcolor: symbioColors.teal.dark },
                    px: 4,
                  }}
                >
                  {saving ? "Saving..." : "Launch Symbio!"}
                </Button>
              ) : (
                <Button
                  onClick={handleNext}
                  disabled={!canProceed()}
                  variant="contained"
                  sx={{
                    bgcolor: canProceed() ? symbioColors.teal.main : symbioColors.dark.border,
                    "&:hover": { bgcolor: canProceed() ? symbioColors.teal.dark : symbioColors.dark.border },
                    px: 3,
                  }}
                >
                  Next
                </Button>
              )}
            </Stack>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
};

// ── Helper Components ──────────────────────────────────────────────

const SummaryRow = ({ label, value }: { label: string; value: string }) => (
  <Stack direction="row" spacing={1} alignItems="baseline">
    <Typography variant="caption" color={symbioColors.silver.dark} sx={{ minWidth: 70 }}>
      {label}:
    </Typography>
    <Typography variant="caption" color={symbioColors.silver.light}>
      {value}
    </Typography>
  </Stack>
);

// ── Shared Styles ──────────────────────────────────────────────────

const fieldStyle = {
  "& .MuiOutlinedInput-root": {
    "& fieldset": { borderColor: symbioColors.dark.border },
    "&:hover fieldset": { borderColor: symbioColors.silver.dark },
    "&.Mui-focused fieldset": { borderColor: symbioColors.teal.main },
  },
  "& .MuiInputLabel-root": { color: symbioColors.silver.dark },
  "& .MuiInputBase-input": { color: "white" },
  "& .MuiFormHelperText-root": { color: symbioColors.silver.dark },
};

export default SetupWizard;