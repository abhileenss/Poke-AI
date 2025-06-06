import OpenAI from "openai";
import { EmailMessage, EmailSender } from "./gmailService";

export interface CategoryResult {
  category: 'call-me' | 'remind-me' | 'keep-quiet' | 'why-did-i-signup' | 'dont-tell-anyone';
  suggestedCategory: 'call-me' | 'remind-me' | 'keep-quiet' | 'why-did-i-signup' | 'dont-tell-anyone';
  confidence: number; // 0-1 scale for AI confidence
  importance: number; // 1-5 scale
  reasoning: string;
  summary: string;
  sentiment: {
    score: number; // -1 to 1 (negative to positive)
    confidence: number; // 0 to 1
    tone: 'urgent' | 'neutral' | 'friendly' | 'promotional' | 'angry' | 'excited';
  };
  priority: {
    score: number; // 1-5 scale
    factors: string[]; // reasons for priority level
    timeToRespond: 'immediate' | 'today' | 'this-week' | 'when-convenient' | 'never';
  };
}

export interface NewsletterAnalysis {
  isNewsletter: boolean;
  frequency: 'daily' | 'weekly' | 'monthly' | 'irregular';
  contentType: string;
  unsubscribeLink?: string;
  summary: string;
}

export class EmailCategorizationService {
  private openai?: OpenAI;
  private hasApiKey: boolean;

  constructor() {
    this.hasApiKey = !!process.env.OPENAI_API_KEY;
    if (this.hasApiKey) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  // Categorize a single email using AI
  async categorizeEmail(message: EmailMessage): Promise<CategoryResult> {
    try {
      // If no API key available, use fallback categorization
      if (!this.hasApiKey || !this.openai) {
        console.warn('OpenAI API key not configured, using fallback categorization');
        return this.fallbackCategorization(message);
      }
      
      const prompt = `
        You are mailieAI, the quirky email concierge for startup founders. Your job is to sort through the chaos and put emails into these brutally honest buckets:

        Categories (choose wisely):
        - "call-me": DROP EVERYTHING emails - investors, angry customers, payment failures, server down, co-founder drama
        - "remind-me": Important founder stuff - board meetings, investor updates, key hires, product launches  
        - "keep-quiet": Useful but not urgent - industry news you actually want, tool updates, team announcements
        - "why-did-i-signup": Marketing emails from tools you use - Stripe, AWS, Notion trying to upsell you again
        - "dont-tell-anyone": Complete garbage - newsletters you never read, spam, LinkedIn spam, conference invites you'll never attend

        IMPORTANT: Look for newsletter patterns:
        - Emails with "newsletter", "digest", "weekly", "update", "insights" in subject/sender
        - Regular content from McKinsey, Harvard Business Review, TechCrunch, etc.
        - Unsubscribe links and newsletter-style formatting
        - These should go to "dont-tell-anyone" unless clearly valuable to founders

        Email to categorize:
        From: ${message.from}
        Subject: ${message.subject}
        Snippet: ${message.snippet}
        Date: ${message.date.toISOString()}

        Think like a startup founder who gets 200+ emails daily. What would make them say "I need to deal with this NOW" vs "this can wait" vs "why is this even in my inbox"?

        Respond with JSON in this exact format:
        {
          "suggestedCategory": "category-name",
          "confidence": 0.1-1.0,
          "importance": 1-5,
          "reasoning": "why this matters (or doesn't) to a busy founder",
          "summary": "what this email is actually about",
          "sentiment": {
            "score": -1 to 1,
            "confidence": 0 to 1,
            "tone": "urgent|neutral|friendly|promotional|angry|excited"
          },
          "priority": {
            "score": 1-5,
            "factors": ["reason1", "reason2"],
            "timeToRespond": "immediate|today|this-week|when-convenient|never"
          }
        }
      `;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.3
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      return {
        suggestedCategory: result.category || 'keep-quiet',
        confidence: Math.max(0, Math.min(1, result.confidence || 0.7)),
        importance: Math.max(1, Math.min(5, result.importance || 3)),
        reasoning: result.reasoning || 'Automated categorization',
        summary: result.summary || message.snippet,
        sentiment: {
          score: Math.max(-1, Math.min(1, result.sentiment?.score || 0)),
          confidence: Math.max(0, Math.min(1, result.sentiment?.confidence || 0.5)),
          tone: result.sentiment?.tone || 'neutral'
        },
        priority: {
          score: Math.max(1, Math.min(5, result.priority?.score || 3)),
          factors: result.priority?.factors || ['Email content analysis'],
          timeToRespond: result.priority?.timeToRespond || 'when-convenient'
        }
      };
    } catch (error) {
      console.error('Error categorizing email:', error);
      // Fallback categorization without AI
      return this.fallbackCategorization(message);
    }
  }

  // Categorize multiple emails in batch
  async categorizeEmails(messages: EmailMessage[]): Promise<Map<string, CategoryResult>> {
    const categorizedEmails = new Map<string, CategoryResult>();
    
    // Process emails in batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const promises = batch.map(async (message) => {
        const result = await this.categorizeEmail(message);
        categorizedEmails.set(message.id, result);
      });
      
      await Promise.all(promises);
      
      // Small delay between batches to respect rate limits
      if (i + batchSize < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return categorizedEmails;
  }

  // Analyze newsletter patterns for a sender
  async analyzeNewsletter(sender: EmailSender, recentMessages: EmailMessage[]): Promise<NewsletterAnalysis> {
    try {
      if (!this.hasApiKey || !this.openai) {
        return this.fallbackNewsletterAnalysis(sender, recentMessages);
      }

      const sampleEmails = recentMessages.slice(0, 5);
      const prompt = `
        Analyze this email sender to determine if they send newsletters and their patterns.

        Sender: ${sender.email} (${sender.name})
        Recent emails (${sampleEmails.length}):
        ${sampleEmails.map((msg, i) => `
        ${i + 1}. Subject: ${msg.subject}
           Date: ${msg.date.toISOString()}
           Snippet: ${msg.snippet}
        `).join('\n')}

        Determine:
        1. Is this a legitimate newsletter/content subscription?
        2. What's the sending frequency?
        3. What type of content is it?
        4. Provide a summary

        Respond with JSON:
        {
          "isNewsletter": true/false,
          "frequency": "daily|weekly|monthly|irregular",
          "contentType": "description of content type",
          "summary": "brief summary of what this newsletter provides"
        }
      `;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.3
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      return {
        isNewsletter: result.isNewsletter || false,
        frequency: result.frequency || 'irregular',
        contentType: result.contentType || 'unknown',
        summary: result.summary || `Emails from ${sender.name || sender.email}`
      };
    } catch (error) {
      console.error('Error analyzing newsletter:', error);
      return this.fallbackNewsletterAnalysis(sender, recentMessages);
    }
  }

  // Fallback newsletter detection when AI is unavailable
  private fallbackNewsletterAnalysis(sender: EmailSender, messages: EmailMessage[]): NewsletterAnalysis {
    const email = sender.email.toLowerCase();
    const domain = sender.domain.toLowerCase();
    
    // Common newsletter indicators
    const newsletterIndicators = [
      'newsletter', 'digest', 'update', 'brief', 'recap', 'roundup',
      'noreply', 'news', 'bulletin', 'report', 'weekly', 'daily'
    ];
    
    const isNewsletterDomain = 
      email.includes('noreply') || 
      email.includes('no-reply') ||
      newsletterIndicators.some(indicator => 
        email.includes(indicator) || domain.includes(indicator)
      );
    
    // Analyze frequency from message timestamps
    let frequency: 'daily' | 'weekly' | 'monthly' | 'irregular' = 'irregular';
    if (messages.length >= 3) {
      const dates = messages.map(m => m.date).sort((a, b) => a.getTime() - b.getTime());
      const intervals = [];
      for (let i = 1; i < dates.length; i++) {
        const diffDays = (dates[i].getTime() - dates[i-1].getTime()) / (1000 * 60 * 60 * 24);
        intervals.push(diffDays);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      
      if (avgInterval <= 2) frequency = 'daily';
      else if (avgInterval <= 8) frequency = 'weekly';
      else if (avgInterval <= 35) frequency = 'monthly';
    }
    
    return {
      isNewsletter: isNewsletterDomain || messages.length > 5,
      frequency,
      contentType: isNewsletterDomain ? 'Newsletter content' : 'Regular communications',
      summary: `${frequency} emails from ${sender.name || sender.email}`,
      unsubscribeLink: messages[0]?.body?.includes('unsubscribe') ? 'Found' : undefined
    };
  }

  // Summarize newsletters for voice calls
  async summarizeNewsletters(newsletters: EmailMessage[]): Promise<string> {
    try {
      if (!this.hasApiKey || !this.openai) {
        return this.fallbackNewsletterSummary(newsletters);
      }

      const newsletterContent = newsletters.slice(0, 5).map((email, i) => `
        ${i + 1}. From: ${email.from}
        Subject: ${email.subject}
        Content: ${email.snippet}
        Date: ${email.date.toISOString()}
      `).join('\n');

      const prompt = `
        Summarize these newsletters for a busy founder's daily voice briefing:
        
        ${newsletterContent}
        
        Create a concise 30-second summary that highlights:
        1. Key industry trends or insights
        2. Important updates relevant to founders
        3. Any actionable items or opportunities
        
        Keep it conversational for voice delivery.
      `;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      });

      return response.choices[0].message.content || this.fallbackNewsletterSummary(newsletters);
    } catch (error) {
      console.error('Error summarizing newsletters:', error);
      return this.fallbackNewsletterSummary(newsletters);
    }
  }

  private fallbackNewsletterSummary(newsletters: EmailMessage[]): string {
    const count = newsletters.length;
    const sourceSet = new Set(newsletters.map(n => n.from.split('@')[0]));
    const sources = Array.from(sourceSet).slice(0, 3);
    return `You have ${count} newsletter updates from ${sources.join(', ')}. Check them when convenient.`;
  }

  // Generate voice call script from actual email data
  async generateCallScript(categorizedEmails: Map<string, CategoryResult>, userPreferences: any): Promise<string> {
    try {
      const emailsByCategory = new Map<string, number>();
      const importantEmails: string[] = [];

      categorizedEmails.forEach((result, emailId) => {
        const count = emailsByCategory.get(result.suggestedCategory) || 0;
        emailsByCategory.set(result.suggestedCategory, count + 1);

        if (result.importance >= 4) {
          importantEmails.push(result.summary);
        }
      });

      const prompt = `
        Generate a natural voice call script for a founder's daily email digest.
        
        Email breakdown:
        - Call me: ${emailsByCategory.get('call-me') || 0} urgent emails
        - Remind me: ${emailsByCategory.get('remind-me') || 0} important emails  
        - Keep quiet: ${emailsByCategory.get('keep-quiet') || 0} low priority emails
        - Why did I signup: ${emailsByCategory.get('why-did-i-signup') || 0} promotional emails
        - Don't tell anyone: ${emailsByCategory.get('dont-tell-anyone') || 0} spam emails
        - Newsletters: ${emailsByCategory.get('newsletter') || 0} newsletter emails

        Important email summaries:
        ${importantEmails.map((summary, i) => `${i + 1}. ${summary}`).join('\n')}

        Create a 30-60 second voice script that:
        1. Greets the founder warmly
        2. Highlights the most important items
        3. Gives a quick overview of other categories
        4. Ends with a professional sign-off
      `;

      const response = await this.openai?.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      });

      if (!response) {
        throw new Error('OpenAI service not available');
      }

      return response.choices[0].message.content || "Hey! Just checking in with your email digest. Everything looks manageable today.";
    } catch (error) {
      console.error('Error generating call script:', error);
      return "Hey! Just checking in with your email digest. Everything looks manageable today.";
    }
  }

  // Fallback categorization without AI
  private fallbackCategorization(message: EmailMessage): CategoryResult {
    const subject = message.subject.toLowerCase();
    const from = message.from.toLowerCase();

    // Simple keyword-based categorization
    if (subject.includes('urgent') || subject.includes('asap') || subject.includes('immediate')) {
      return {
        suggestedCategory: 'call-me',
        confidence: 0.8,
        importance: 4,
        reasoning: 'Contains urgent keywords',
        summary: message.snippet,
        sentiment: { score: -0.2, confidence: 0.7, tone: 'urgent' },
        priority: { score: 4, factors: ['Urgent keywords detected'], timeToRespond: 'immediate' }
      };
    }

    if (subject.includes('meeting') || subject.includes('call') || subject.includes('schedule')) {
      return {
        suggestedCategory: 'remind-me',
        confidence: 0.7,
        importance: 3,
        reasoning: 'Meeting or scheduling related',
        summary: message.snippet,
        sentiment: { score: 0.1, confidence: 0.6, tone: 'neutral' },
        priority: { score: 3, factors: ['Meeting related'], timeToRespond: 'today' }
      };
    }

    if (subject.includes('newsletter') || subject.includes('digest') || from.includes('noreply')) {
      return {
        suggestedCategory: 'keep-quiet',
        confidence: 0.8,
        importance: 2,
        reasoning: 'Appears to be newsletter content',
        summary: message.snippet,
        sentiment: { score: 0.2, confidence: 0.8, tone: 'neutral' },
        priority: { score: 2, factors: ['Newsletter content'], timeToRespond: 'when-convenient' }
      };
    }

    if (subject.includes('promotion') || subject.includes('sale') || subject.includes('offer')) {
      return {
        suggestedCategory: 'why-did-i-signup',
        confidence: 0.6,
        importance: 1,
        reasoning: 'Promotional content',
        summary: message.snippet,
        sentiment: { score: 0.3, confidence: 0.6, tone: 'promotional' },
        priority: { score: 1, factors: ['Promotional email'], timeToRespond: 'never' }
      };
    }

    return {
      suggestedCategory: 'keep-quiet',
      confidence: 0.5,
      importance: 2,
      reasoning: 'General email',
      summary: message.snippet,
      sentiment: { score: 0.0, confidence: 0.5, tone: 'neutral' },
      priority: { score: 2, factors: ['General content'], timeToRespond: 'when-convenient' }
    };
  }
}