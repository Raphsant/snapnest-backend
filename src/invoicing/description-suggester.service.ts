import Anthropic from '@anthropic-ai/sdk';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoiceLanguage } from '@prisma/client';
import { SuggestDescriptionsDto } from './dto/suggest-descriptions.dto';

const MODEL = 'claude-sonnet-5-5';
const OPTION_COUNT = 10;
const MAX_DESCRIPTION = 110;
const MAX_SERVICE_NAME = 60;
const MIN_NAME_WORDS = 2;
const MAX_NAME_WORDS = 5;

const LANGUAGE_NAMES: Record<InvoiceLanguage, string> = {
  EN: 'English',
  ES: 'Spanish',
};

const SYSTEM_PROMPT = `You are an invoicing assistant for a marketing and events agency. The operator
gives you the names of one or more invoice line items (for example "Evento
Houston") and, optionally, some context about the work. Your job is to suggest
how that work could be presented on a client invoice.

Return exactly 10 options. Each option has two fields:
- serviceName: 2 to 5 words, Title Case, professional — the name of the
  service as it would appear on the invoice line.
- description: a single line of at most 110 characters that states what was
  included. Use standard invoicing terms where they fit, such as turnkey,
  full-service, end-to-end, production, management, coordination and
  deliverables.

Make the 10 options genuinely different from each other. Vary the angle
(what the client is paying for), the scope (a single event versus a program
covering several), and the formality (plain versus formal). No two options
should be near-duplicates or reworded copies of each other. Base everything on
the line names and context given; don't invent specific figures, dates or
venues that weren't provided.

Write both fields in the language named in the request.

Respond with ONLY a JSON array of 10 objects, each with exactly the keys
"serviceName" and "description". No prose before or after, no code fences.`;

export interface DescriptionOption {
  serviceName: string;
  description: string;
}

export interface SuggestDescriptionsResult {
  options: DescriptionOption[];
}

@Injectable()
export class DescriptionSuggesterService {
  private readonly logger = new Logger(DescriptionSuggesterService.name);
  private readonly client: Anthropic;

  constructor(configService: ConfigService) {
    const apiKey = configService.getOrThrow<string>('ANTHROPIC_API_KEY');
    this.client = new Anthropic({ apiKey });
  }

  async suggest(
    dto: SuggestDescriptionsDto,
  ): Promise<SuggestDescriptionsResult> {
    const userMessage = this.buildUserMessage(dto);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const options = this.parseOptions(await this.callModel(userMessage));
      if (options) return { options };
      this.logger.warn(`Unusable suggestion response (attempt ${attempt})`);
    }
    throw new BadGatewayException(
      'Suggestion service returned an unusable response',
    );
  }

  private buildUserMessage(dto: SuggestDescriptionsDto): string {
    const parts = [
      `Language: ${LANGUAGE_NAMES[dto.language]}`,
      `Line names: ${dto.items.join(' / ')}`,
    ];
    if (dto.context) parts.push(`Context: ${dto.context}`);
    return parts.join('\n');
  }

  // Returns the first text block, or null on a refusal or truncated output.
  private async callModel(userMessage: string): Promise<string | null> {
    const started = Date.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        // Lowest thinking setting on Sonnet 5.5 only; revisit if MODEL changes.
        thinking: { type: 'between_tools' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const status =
          typeof err.status === 'number' ? err.status : 'connection';
        this.logger.warn(`Anthropic API error: ${err.name} (${status})`);
        throw new BadGatewayException(
          `Suggestion service error (status ${status})`,
        );
      }
      throw err;
    }
    this.logger.debug(
      `model=${response.model} latencyMs=${Date.now() - started} ` +
        `inputTokens=${response.usage.input_tokens} ` +
        `outputTokens=${response.usage.output_tokens} ` +
        `stop=${response.stop_reason}`,
    );
    if (response.stop_reason !== 'end_turn') return null;
    const block = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    return block ? block.text : null;
  }

  private parseOptions(text: string | null): DescriptionOption[] | null {
    if (text === null) return null;
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== OPTION_COUNT) return null;
    const options: DescriptionOption[] = [];
    for (const item of parsed as unknown[]) {
      if (typeof item !== 'object' || item === null) return null;
      const { serviceName, description } = item as Record<string, unknown>;
      if (typeof serviceName !== 'string' || typeof description !== 'string') {
        return null;
      }
      const name = serviceName.trim();
      const desc = description.trim();
      if (!name || !desc) return null;
      const words = name.split(/\s+/).length;
      if (words < MIN_NAME_WORDS || words > MAX_NAME_WORDS) return null;
      options.push({
        serviceName: name.slice(0, MAX_SERVICE_NAME),
        description: desc.slice(0, MAX_DESCRIPTION),
      });
    }
    return options;
  }
}
