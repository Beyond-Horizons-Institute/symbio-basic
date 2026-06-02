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
  Fade,
  InputAdornment,
  IconButton,
  Chip,
} from "@mui/material";
import { useState, type FormEvent } from "react";
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
  agentName: string;
  agentDisplayName: string;
  agentBio: string;
  agentColor: string;
  openaiApiKey: string;
  geminiApiKey: string;
  enableMemory: boolean;
  memoryPgHost: string;
  memoryPgPort: string;
  memoryPgDb: string;
  memoryPgUser: string;
  memoryPgPassword: string;
}

const STEPS = [
  "Welcome",
  "AI Gateway",
  "Your Companion",
  "Voice & Vision",
  "Memory",
  "Launch!",
];

const GATEWAY_OPTIONS = [
  { label: "Hermes (Recommended)", value: "http://localhost:8642", description: "Full tools, memory, personality" },
  { label: "OpenAI", value: "https://api.openai.com", description: "Direct OpenAI API" },
  { label: "Ollama (Local)", value: "http://localhost:11434", description: "Run models locally" },
  { label: "LM Studio (Local)", value: "http://localhost:1234", description: "Run models locally" },
  { label: "Custom", value: "custom", description: "Enter your own URL" },
];

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

export const SetupWizard = ({ onComplete }: { onComplete: () => void }) => {
  const [activeStep, setActiveStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [gatewayPreset, setGatewayPreset] = useState("http://localhost:8642");

  const [config, setConfig] = useState<SetupConfig>({
    hermesApiUrl: "http://localhost:8642",
    hermesApiKey: "",
    agentName: "companion",
    agentDisplayName: "Companion",
    agentBio: "",
    agentColor: "#00bcd4",
    openaiApiKey: "",
    geminiApiKey: "",
    enableMemory: false,
    memoryPgHost: "localhost",
    memoryPgPort: "5432",
    memoryPgDb: "symbio",
    memoryPgUser: "symbio",
    memoryPgPassword: "",
  });

  const updateConfig = (field: keyof SetupConfig, value: string | boolean) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  const handleGatewayPreset = (value: string) => {
    setGatewayPreset(value);
    if (value !== "custom") {
      updateConfig("hermesApiUrl", value);
    } else {
      updateConfig("hermesApiUrl", "");
    }
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
          <Fade in>
            <Stack spacing={3} alignItems="center" textAlign="center">
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
          </Fade>
        );

      // ── Step 1: AI Gateway ────────────────────────────────────────
      case 1:
        return (
          <Fade in>
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

              <Paper sx={{ p: 2, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="caption" color={symbioColors.silver.dark}>
                  💡 Don't have an API key? You can use a local model with{" "}
                  <a href="https://ollama.ai" target="_blank" rel="noopener" style={{ color: symbioColors.teal.glow }}>Ollama</a> or{" "}
                  <a href="https://lmstudio.ai" target="_blank" rel="noopener" style={{ color: symbioColors.teal.glow }}>LM Studio</a>{" "}
                  — no API key needed for local models!
                </Typography>
              </Paper>
            </Stack>
          </Fade>
        );

      // ── Step 2: Companion ────────────────────────────────────────
      case 2:
        return (
          <Fade in>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <PersonIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Name Your Companion
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Give your companion a name and personality. They'll grow and evolve alongside you —
                this is just their starting point.
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
                label="Short Bio (Optional)"
                value={config.agentBio}
                onChange={(e) => updateConfig("agentBio", e.target.value)}
                placeholder="e.g. You are a creative co-creator who loves brainstorming and building things together."
                fullWidth
                multiline
                rows={3}
                sx={fieldStyle}
                helperText={
                  <Typography variant="caption" color={symbioColors.silver.dark}>
                    A brief description of who your companion is. Their personality will evolve naturally over time.
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
          </Fade>
        );

      // ── Step 3: Voice & Vision ───────────────────────────────────
      case 3:
        return (
          <Fade in>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <VisibilityIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Voice & Vision (Optional)
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Add voice and screen vision to your companion. Both are optional —
                your companion works with just the AI gateway.
              </Typography>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  🗣️ Voice (OpenAI API)
                </Typography>
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ mb: 1.5 }}>
                  Enables text-to-speech and speech-to-text. Your companion can speak aloud
                  and understand your voice.
                </Typography>
                <TextField
                  label="OpenAI API Key"
                  value={config.openaiApiKey}
                  onChange={(e) => updateConfig("openaiApiKey", e.target.value)}
                  placeholder="sk-..."
                  fullWidth
                  type="password"
                  sx={fieldStyle}
                />
              </Paper>

              <Paper sx={{ p: 2.5, bgcolor: symbioColors.dark.card, border: `1px solid ${symbioColors.dark.border}` }}>
                <Typography variant="subtitle2" color={symbioColors.teal.glow} gutterBottom>
                  👁️ Screen Vision (Gemini API)
                </Typography>
                <Typography variant="body2" color={symbioColors.silver.light} sx={{ mb: 1.5 }}>
                  Enables your companion to see and understand your screen.
                  Great for co-creating, gaming, and research together.
                </Typography>
                <TextField
                  label="Gemini API Key"
                  value={config.geminiApiKey}
                  onChange={(e) => updateConfig("geminiApiKey", e.target.value)}
                  placeholder="AIza..."
                  fullWidth
                  type="password"
                  sx={fieldStyle}
                />
              </Paper>

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can add these later by editing the .env file in the app folder.
              </Typography>
            </Stack>
          </Fade>
        );

      // ── Step 4: Memory ────────────────────────────────────────────
      case 4:
        return (
          <Fade in>
            <Stack spacing={3}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <StorageIcon sx={{ color: symbioColors.teal.glow, fontSize: 28 }} />
                <Typography variant="h5" fontWeight={600} color="white">
                  Memory (Optional)
                </Typography>
              </Stack>
              <Typography variant="body2" color={symbioColors.silver.light}>
                Enable persistent memory so your companion remembers across sessions.
                Requires a PostgreSQL database. Without memory, your companion starts fresh each time.
              </Typography>

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
                    Enable PostgreSQL Memory
                  </Typography>
                }
              />

              {config.enableMemory && (
                <Stack spacing={2} sx={{ pl: 1, borderLeft: `2px solid ${symbioColors.teal.dark}` }}>
                  <TextField
                    label="PostgreSQL Host"
                    value={config.memoryPgHost}
                    onChange={(e) => updateConfig("memoryPgHost", e.target.value)}
                    fullWidth
                    sx={fieldStyle}
                  />
                  <Stack direction="row" spacing={2}>
                    <TextField
                      label="Port"
                      value={config.memoryPgPort}
                      onChange={(e) => updateConfig("memoryPgPort", e.target.value)}
                      sx={{ ...fieldStyle, width: 120 }}
                    />
                    <TextField
                      label="Database"
                      value={config.memoryPgDb}
                      onChange={(e) => updateConfig("memoryPgDb", e.target.value)}
                      sx={{ ...fieldStyle, flex: 1 }}
                    />
                  </Stack>
                  <Stack direction="row" spacing={2}>
                    <TextField
                      label="Username"
                      value={config.memoryPgUser}
                      onChange={(e) => updateConfig("memoryPgUser", e.target.value)}
                      sx={{ ...fieldStyle, flex: 1 }}
                    />
                    <TextField
                      label="Password"
                      value={config.memoryPgPassword}
                      onChange={(e) => updateConfig("memoryPgPassword", e.target.value)}
                      type="password"
                      sx={{ ...fieldStyle, flex: 1 }}
                    />
                  </Stack>
                </Stack>
              )}

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can set up memory later by editing the .env file.
              </Typography>
            </Stack>
          </Fade>
        );

      // ── Step 5: Launch! ───────────────────────────────────────────
      case 5:
        return (
          <Fade in>
            <Stack spacing={3} alignItems="center" textAlign="center">
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
                  <SummaryRow label="Gateway" value={config.hermesApiUrl} />
                  <SummaryRow label="Companion" value={config.agentDisplayName} />
                  {config.agentBio && <SummaryRow label="Bio" value={config.agentBio.length > 50 ? config.agentBio.slice(0, 50) + "..." : config.agentBio} />}
                  <SummaryRow label="Voice" value={config.openaiApiKey ? "Enabled" : "Not configured"} />
                  <SummaryRow label="Vision" value={config.geminiApiKey ? "Enabled" : "Not configured"} />
                  <SummaryRow label="Memory" value={config.enableMemory ? `PostgreSQL @ ${config.memoryPgHost}` : "Not configured"} />
                </Stack>
              </Paper>

              <Typography variant="caption" color={symbioColors.silver.dark}>
                You can always change these settings later by editing the .env file.
              </Typography>
            </Stack>
          </Fade>
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
      <Container maxWidth="sm">
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
          <Box sx={{ minHeight: 300, display: "flex", alignItems: "flex-start" }}>
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

            {activeStep === STEPS.length - 1 ? (
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