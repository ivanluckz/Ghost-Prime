import { runCommand } from './terminal.js'
import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserFill,
  browserGetText,
  browserClose
} from './browser.js'

// Dispatch map: tool name -> async handler(args) -> result object.
export const toolHandlers = {
  terminal_run: ({ command, timeout_ms }) => runCommand({ command, timeoutMs: timeout_ms }),
  browser_navigate: ({ url }) => browserNavigate({ url }),
  browser_screenshot: () => browserScreenshot(),
  browser_click: ({ selector }) => browserClick({ selector }),
  browser_fill: ({ selector, value }) => browserFill({ selector, value }),
  browser_get_text: () => browserGetText(),
  browser_close: () => browserClose()
}

// OpenAI-compatible function-calling schemas (works through OpenRouter and Gemini).
// Consumed by the Phase 3 agent loop.
export const toolSpecs = [
  {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: 'Run a bash command on the local machine and return its stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run.' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (default 30000).' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Open a URL in the controlled browser. Returns the final URL and page title.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to navigate to.' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the current browser page (returned as base64) for visual inspection.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the current page by CSS selector.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector of the element to click.' } },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Type a value into an input/textarea on the current page by CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the field.' },
          value: { type: 'string', description: 'The text to enter.' }
        },
        required: ['selector', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Extract the visible text of the current page (cleaned, truncated). Use to read page content.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the controlled browser and free its resources.',
      parameters: { type: 'object', properties: {} }
    }
  }
]
