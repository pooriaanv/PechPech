'use strict';

const { spawn } = require('child_process');

// ── CLI Adapter ───────────────────────────────────────────────────
// Invokes a local LLM CLI tool via child_process.spawn.
// Claude pipes the prompt via stdin to avoid OS arg-length limits.
// All other CLIs receive the prompt as the first argument.

function createCLIAdapter({ llmCli, llmCommand }) {
  const cli = llmCli || 'claude';

  return {
    invoke(promptText) {
      return new Promise((resolve, reject) => {
        let cmd, args, useStdin;

        switch (cli) {
          case 'claude':
            cmd      = 'claude';
            args     = ['-p'];
            useStdin = true;
            break;

          case 'codex':
            cmd      = 'codex';
            args     = [promptText];
            useStdin = false;
            break;

          case 'gemini':
            cmd      = 'gemini';
            args     = [promptText];
            useStdin = false;
            break;

          case 'custom': {
            const customCmd = llmCommand || '';
            if (!customCmd) {
              reject(new Error('Custom CLI selected but no command specified in settings.'));
              return;
            }
            const parts = customCmd.trim().split(/\s+/);
            cmd         = parts[0];
            args        = [...parts.slice(1), promptText];
            useStdin    = false;
            break;
          }

          default:
            reject(new Error(`Unknown LLM CLI: "${cli}". Valid values: claude, custom.`));
            return;
        }

        console.log(`[llm] CLI: ${cmd} (prompt ${promptText.length} chars)`);

        const proc = spawn(cmd, args, { shell: false, env: { ...process.env } });

        let stdout = '';
        let stderr = '';
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', chunk => { stdout += chunk; });
        proc.stderr.on('data', chunk => { stderr += chunk; });

        if (useStdin) {
          proc.stdin.write(promptText, 'utf8');
          proc.stdin.end();
        }

        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`LLM CLI timed out after 15 minutes. Command: ${cmd}`));
        }, 900_000);

        proc.on('error', err => {
          clearTimeout(timeout);
          if (err.code === 'ENOENT') {
            reject(new Error(
              `CLI not found: "${cmd}". Is it installed and on PATH?\n` +
              `  Claude Code: npm install -g @anthropic-ai/claude-code && claude login`
            ));
          } else {
            reject(new Error(`CLI spawn error: ${err.message}`));
          }
        });

        proc.on('close', code => {
          clearTimeout(timeout);
          if (code !== 0) {
            const detail = stderr.slice(-300);
            reject(new Error(
              `CLI exited with code ${code}.\n` +
              (detail ? `Stderr: ${detail}` : 'No stderr output.')
            ));
            return;
          }
          if (!stdout.trim()) {
            reject(new Error(`CLI produced no output. Command: ${cmd}`));
            return;
          }
          resolve(stdout);
        });
      });
    },
  };
}

// ── API Adapter ───────────────────────────────────────────────────
// Calls any OpenAI-compatible /chat/completions endpoint.
// Requires Node 18+ for native fetch.

function createAPIAdapter({ llmApiUrl, llmApiKey, llmApiModel }) {
  const baseUrl = (llmApiUrl || '').replace(/\/$/, '');
  const apiKey  = llmApiKey   || '';
  const model   = llmApiModel || 'gpt-4o';

  if (!baseUrl) {
    throw new Error(
      'API mode selected but API URL is not set. ' +
      'Configure it in the extension settings or set LLM_API_URL in .env.'
    );
  }

  return {
    async invoke(promptText) {
      console.log(`[llm] API: ${baseUrl}/chat/completions model=${model} (prompt ${promptText.length} chars)`);

      let response;
      try {
        response = await globalThis.fetch(`${baseUrl}/chat/completions`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body:   JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptText }],
          }),
          signal: AbortSignal.timeout(900_000),
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new Error(`LLM API timed out after 15 minutes. URL: ${baseUrl}`);
        }
        throw new Error(`LLM API unreachable: ${err.message}`);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`LLM API returned HTTP ${response.status}: ${detail || response.statusText}`);
      }

      let json;
      try { json = await response.json(); }
      catch { throw new Error('LLM API returned invalid JSON.'); }

      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(
          `LLM API response missing choices[0].message.content. ` +
          `Got: ${JSON.stringify(json).slice(0, 200)}`
        );
      }

      return text;
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────
// Selects the right adapter based on config.llmCli.
// Called per-request — provider type comes from extension settings each time.

function createProvider(config) {
  const cli = config.llmCli || 'claude';
  if (cli === 'api') {
    return createAPIAdapter({
      llmApiUrl:   config.llmApiUrl,
      llmApiKey:   config.llmApiKey,
      llmApiModel: config.llmApiModel,
    });
  }
  return createCLIAdapter({
    llmCli:     cli,
    llmCommand: config.llmCommand,
  });
}

module.exports = { createProvider };
