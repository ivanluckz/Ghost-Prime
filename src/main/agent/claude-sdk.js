import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'

function formatTranscript(messages) {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

function extractAssistantText(message) {
  const blocks = message.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function sdkEnv() {
  return {
    ...process.env,
    PATH: `${homedir()}/.local/bin:${process.env.PATH || ''}`,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'ghost-prime/0.1.0'
  }
}

function linkAbortController(signal) {
  const abortController = new AbortController()
  if (!signal) return abortController
  if (signal.aborted) abortController.abort()
  else signal.addEventListener('abort', () => abortController.abort(), { once: true })
  return abortController
}

export async function streamChatClaudeSdk({ messages, signal, onDelta, model, systemPrompt }) {
  const useModel = model || process.env.CLAUDE_AGENT_MODEL || 'haiku'
  const abortController = linkAbortController(signal)

  const options = {
    model: useModel,
    systemPrompt,
    includePartialMessages: true,
    maxTurns: 1,
    tools: [],
    cwd: homedir(),
    abortController,
    env: sdkEnv()
  }
  if (process.env.CLAUDE_BIN) options.pathToClaudeCodeExecutable = process.env.CLAUDE_BIN

  const q = query({ prompt: formatTranscript(messages), options })

  let full = ''
  let streamed = false

  try {
    for await (const message of q) {
      if (abortController.signal.aborted) break

      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text
          if (text) {
            full += text
            streamed = true
            onDelta(text)
          }
        }
        continue
      }

      if (message.type === 'assistant') {
        if (message.error) {
          throw new Error(`Claude error: ${message.error}`)
        }
        if (!streamed) {
          const text = extractAssistantText(message)
          if (text) {
            full = text
            onDelta(text)
            streamed = true
          }
        }
        continue
      }

      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const detail = message.errors?.join('\n') || message.subtype
          throw new Error(detail)
        }
        if (!streamed && message.result) {
          full = message.result
          onDelta(message.result)
        }
      }
    }

    return full
  } finally {
    q.close()
  }
}
