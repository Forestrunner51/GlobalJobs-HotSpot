// Drafts answers to an application's open questions ("Why this company?") with Claude, from your
// profile and the job description. Runs in the service worker, only when you click "Draft
// answers" in the popup, and only with your own API key (profile page). Sent to the API: the
// job's title, company and description, the questions, and your work history, education, skills
// and saved answers. Not sent: your name, email, phone, address or links.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { JobInfo } from './core/applications';
import type { Profile } from './core/profile';

export interface DraftQuestion {
  id: string;
  question: string;
}

const Drafts = z.object({
  answers: z.array(z.object({
    id: z.string(),
    answer: z.string().describe('The answer in first person, or an empty string if the profile has no facts to answer it with'),
  })),
});

const SYSTEM = `You draft answers to the open questions on a job application, for the applicant to review and edit before submitting.
- Write in the applicant's own voice: first person, plain and specific, no clichés or filler ("I am excited to...", "passionate", "synergy").
- Use only facts from the applicant's background below and the job description. Never invent employers, numbers, projects or skills.
- Tie each answer to this company and role: name what in the posting connects to what the applicant has done.
- Keep each answer under 150 words unless the question asks for more. No greeting or sign-off.
- If the background has nothing to answer a question with (a personal preference, a date, a yes/no fact), return an empty string for it.`;

function background(p: Profile): string {
  const work = p.work.map((w) => `${w.title} at ${w.company} (${w.start || '?'} to ${w.current ? 'present' : w.end || '?'})\n${w.description}`).join('\n\n');
  const school = p.education.map((e) => `${e.degree}${e.field ? ` in ${e.field}` : ''}, ${e.school}`).join('\n');
  const saved = p.answers.filter((a) => a.answer).map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
  return [`Work history:\n${work || '(none given)'}`, `Education:\n${school || '(none given)'}`,
    `Skills: ${p.skills.join(', ') || '(none given)'}`, saved && `Answers the applicant has written before:\n${saved}`]
    .filter(Boolean).join('\n\n');
}

export async function draftAnswers(apiKey: string, profile: Profile, job: JobInfo, questions: DraftQuestion[]): Promise<Record<string, string>> {
  // The key is yours and stays in this browser; the SDK needs to be told it's running in one.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'medium', format: betaZodOutputFormat(Drafts) },
    // If the model declines, the API retries on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `<job title="${job.title ?? ''}" company="${job.company ?? ''}">\n${job.description || '(no description available)'}\n</job>\n\n`
        + `<applicant_background>\n${background(profile)}\n</applicant_background>\n\n`
        + `Draft an answer to each question:\n${questions.map((q) => `[${q.id}] ${q.question}`).join('\n')}`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to draft answers for this application.');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude's reply couldn't be read. Try again.");
  return Object.fromEntries(parsed.answers.filter((a) => a.answer.trim()).map((a) => [a.id, a.answer.trim()]));
}

/** A short, user-facing explanation of an API error. */
export function draftError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it on the profile page.';
  if (e instanceof Anthropic.PermissionDeniedError) return "Your API key doesn't have access to this model.";
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a minute and try again.';
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}: ${e.message}`;
  return (e as Error).message;
}
