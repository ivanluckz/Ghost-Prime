// Smoke test for Gemini Autonomous Agent with Jarvis tools
// Run: node scripts/smoke-gemini-agent.mjs
import 'dotenv/config'
import OpenAI from 'openai'
import { toolSpecs, executeTool } from '../src/main/tools/index.js'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('FAIL: GEMINI_API_KEY not set in .env')
  process.exit(1)
}

const client = new OpenAI({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey
})

const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
console.log('--- Testing Gemini Autonomous Agent with Jarvis Tools ---')
console.log('Using Model:', model)

const messages = [
  {
    role: 'system',
    content: 'You are Ghost-Prime (with Jarvis tools). You have tools to check battery, volume, and telemetry. Use your tools when asked.'
  },
  {
    role: 'user',
    content: 'Please check the battery status using system_power, then give a brief summary.'
  }
]

let turns = 0
let toolExecuted = false

while (turns < 5) {
  turns++
  const res = await client.chat.completions.create({
    model,
    messages,
    tools: toolSpecs,
    tool_choice: 'auto'
  })

  const msg = res.choices[0].message
  if (msg.content) {
    process.stdout.write(msg.content + '\n')
  }

  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    console.log('\nFinal response received from Gemini!')
    break
  }

  messages.push(msg)

  for (const call of msg.tool_calls) {
    toolExecuted = true
    const toolName = call.function.name
    const args = JSON.parse(call.function.arguments || '{}')
    console.log(`[TOOL CALL] ${toolName}(${JSON.stringify(args)})`)

    const result = await executeTool(toolName, args)
    console.log(`[TOOL RESULT] ${result.output.slice(0, 120)}...`)

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result.output
    })
  }
}

console.log('\n--- Test Result ---')
if (toolExecuted) {
  console.log('SUCCESS: Gemini successfully executed Jarvis tool!')
} else {
  console.log('NOTICE: Completed without tool execution')
}
