const CLAUDE_SKILL_CHIP = /\[\$claude:([^\]\r\n]+)\]\([^)]+\)/gu;

export function decodeClaudeSkillChips(text: string): { readonly text: string; readonly decoded: boolean } {
  let decoded = false;
  const replaced = text.replace(CLAUDE_SKILL_CHIP, (_chip, name: string) => {
    decoded = true;
    return `/${name}`;
  });
  return { text: replaced, decoded };
}
