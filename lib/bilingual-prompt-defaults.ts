export const DEFAULT_CHECKPHONE_BILINGUAL_PROMPT =
  "This rule only applies to non-Chinese output; Chinese text should be output normally. For readable phone-check text, including titles, bodies, notes, comments, messages, inner thoughts, feelings, status text, Moments, posts, and feed bodies, non-Chinese content must use: complete original text|complete Simplified Chinese translation. For non-Chinese Moments/post/feed body text, keep the original and Chinese translation in the same field; do not put the Chinese translation in a separate paragraph or line without \"|\". Use \"|\" only as the whole-text bilingual separator; use colons, commas, or line breaks inside the text.";

export const DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT = [
  "【小红书双语输出规则（仅非中文角色使用，中文角色忽略此规则）】",
  "- 只对小红书角色生成内容生效，包括帖子标题、正文、评论、回复、图片描述、视频描述、私信正文等自然语言内容。",
  "- 不要改动结构标签、块标题或字段名，例如 #评论1、#角色回复、[标题]、[正文]、[内容]、[图片描述]、[视频描述]。",
  "- 如果某个字段内容使用非中文语言，字段值必须写成“完整原文|对应的简体中文译文”。",
  "- 如果内容本来就是中文，正常输出中文，不要添加 |译文。",
  "- 竖线 | 只作为完整原文和完整译文之间的分隔符，不要在原文或译文内部滥用。",
].join("\n");

export const DEFAULT_CHAT_BILINGUAL_PROMPT = [
  "【双语输出规则（仅非中文角色使用，中文角色忽略此规则)】",
  "**双语输出作用范围**：聊天消息正文、[语音条:...]中的语音内容文字、[引用:原文片段]后面的回复内容、[内心]...[/内心]中的内心想法。当本轮回复使用非中文语言时，以上内容必须使用“原文|对应的简体中文译文”的格式输出",
  "**格式要求**：",
  "- 原文在前，简体中文译文在后，中间只使用一个竖线 |",
  "- 如果内容本来就是中文，则不要添加 |译文",
  "- 不要改动原有富媒体指令格式，只在其中的文本内容内部追加 |中文译文",
  "- [引用:...] 中引用锚点(引用原文）保持原格式，不需要翻译；只翻译其后的回复内容",
].join("\n");

export const DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT = [
  "【群聊双语规则（仅非中文角色使用，中文角色忽略此规则)】",
  "不同角色这一轮可以使用不同语言，请对每个角色的每条发言分别判断。",
  "要求：",
  "- **中文正常输出**：如果该条发言是中文，直接正常输出，不要添加译文",
  "- **非中文翻译格式要求**：如果该条发言使用非中文语言，则该条发言内容必须使用“原文|对应的简体中文译文”的格式输出，必须在原文和译文之间用|分割",
  "- **不改变协议头**：只在 [角色名]: 后面的正文内部使用双语格式，不要改动 [角色名]: 前缀",
].join("\n");

export const DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT = [
  "【线下双语规则（仅非中文角色对白使用，中文对白忽略此规则）】",
  "- 只对 <content> 中角色直接说出口的对白生效。",
  "- 旁白、动作描写、环境描写、事实陈述、心理/氛围陈述、摘要字段都不要双语，不要添加 |译文。",
  "- 如果角色对白使用非中文语言，请把该对白单独成行，写成“完整原文|对应的简体中文译文”。",
  "- 使用双语格式的对白必须作为独立段落输出，前后用空行与旁白隔开；不要把旁白和“原文|译文”混在同一段。",
  "- 如果对白本来就是中文，正常输出中文，不要添加 |译文。",
  "- 不要改动 <content>、摘要 XML 标签或其他结构标签。",
].join("\n");

export const DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT = [
  "【群聊线下双语规则（仅非中文角色对白使用，中文对白忽略此规则）】",
  "- 只对 <content> 中群成员实际说出口的直接对白生效。",
  "- 旁白、动作描写、环境描写、事实陈述、群体氛围陈述、摘要字段都不要双语，不要添加 |译文。",
  "- 如果某个角色的对白使用非中文语言，请把该对白单独成行，写成“完整原文|对应的简体中文译文”。",
  "- 使用双语格式的对白必须作为独立段落输出，前后用空行与旁白或其他动作隔开；不要把旁白和“原文|译文”混在同一段。",
  "- 不要为了双语恢复 [角色名]: 群聊气泡格式；仍然遵守线下连续叙事和 XML 输出格式。",
  "- 中文对白正常输出，不要添加 |译文；不要改动 XML 标签。",
].join("\n");

export const DEFAULT_MOMENTS_BILINGUAL_PROMPT = [
  "【朋友圈双语规则（仅非中文角色使用，中文角色忽略此规则)】",
  "- **不改变协议头和结构标签**：只对你实际输出的正文内容使用双语格式，不要翻译或改动协议头和结构标签，不要改动 [回复 昵称]、[不回复]、[NPC点赞]、[NPC评论]、昵称、以及“昵称 回复 被回复者昵称:”这类结构。",
  "- **中文正常输出无需译文**：如果正文是中文，直接正常输出，不要添加译文",
  "- **非中文语言译文输出格式**：非中文语言，正文必须使用“原文|对应的简体中文译文”的格式输出，必须有|分割符号。",
  "- **朋友圈正文双语补充**：如果朋友圈正文、评论正文或回复正文使用非中文，必须在同一段正文里写成“完整外文原文|完整简体中文译文”。",
  "- **照片双语规则**：如果输出 [照片:使用参考图:描述] 或 [照片:不使用参考图:描述]，只允许描述部分使用双语格式，不要改动照片标签外层结构。",
].join("\n");

export const DEFAULT_READING_BILINGUAL_PROMPT = [
  "【阅读双语规则（仅非中文角色使用，中文角色忽略此规则)】",
  "**作用范围**：对讨论正文（消息回复）和批注生效",
  "**输出格式**：",
  "- 中文正常输出无需译文：如果讨论正文/回复消息是中文，直接正常输出，不要添加译文",
  "- 非中文情况下译文输出格式：如果讨论正文/回复消息使用非中文语言，则正文使用“原文|对应的简体中文译文”的格式输出",
  "- 不要改变协议头，只对内容本身作用：只对内容本身输出译文，不要改变 [批注:N]...[/批注]、【新增批注 ...】、【删除批注 ...】、【修改批注 ...】这些结构",
].join("\n");

export const DEFAULT_VN_BILINGUAL_PROMPT = [
  "【对白双语规则（仅非中文角色使用，中文角色忽略此规则)】",
  "- **只有对白需要双语**：只有对白需要判断是否双语，旁白、动作、环境描写一律正常输出，不要添加译文，只有角色名|\"台词\"里的台词部分允许使用双语格式",
  "- **中文正常输出无需译文**：如果对白台词是中文，直接正常输出，不要添加译文",
  "- **非中文译文输出规则**：如果对白台词使用非中文语言，则台词部分必须使用“原文|对应的简体中文译文”的格式输出，格式为：角色名|\"原文|对应的简体中文译文\"",
  "- **不可改动协议头**：不要改动 <scene>、角色名|、引号、bg、sprite、<options> 等结构",
].join("\n");

export const DEFAULT_ADVENTURE_BILINGUAL_PROMPT = [
  "【角色双语规则（仅非中文角色使用，中文角色忽略此规则)】",
  "- **只对speech字段生效**：只对你输出 JSON 中的 speech 字段生效。action、emotion、affinity 保持正常格式，不要翻译，不要双语",
  "- **中文无需译文**：如果 speech 是中文，直接正常输出，不要添加译文。",
  "- **非中文译文格式**：如果 speech 使用非中文语言，则 speech 使用“原文|对应的简体中文译文”的格式输出，必须有|分割。",
  "- **json结构不变**：必须严格保持 JSON 结构和字段名不变",
].join("\n");

export function resolveBilingualPrompt(enabled: boolean, customPrompt: string | undefined, defaultPrompt: string): string {
  if (!enabled) return "";
  const prompt = customPrompt?.trim();
  return prompt || defaultPrompt;
}
