// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

export const RANGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``

export const MESSAGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNN (ignore metadata attributes like priority)
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``

/**
 * Builds a summary budget instruction appended to the compress tool description.
 * Returns empty string when budget is 0 (disabled) or negative.
 */
export function buildSummaryBudgetExtension(summaryBudget: number): string {
    if (!summaryBudget || summaryBudget <= 0) {
        return ""
    }

    return `\n\nSUMMARY SIZE BUDGET
Each summary you write MUST stay within approximately ${summaryBudget} characters. Be concise: prioritize decisions, file paths, function signatures, and key findings. Omit verbose explanations, large code blocks, and step-by-step narratives. If the budget is tight, use bullet points and abbreviations.`
}
