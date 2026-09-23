import { LEGAL_ENTITY as E } from './entity';
import type { LegalCatalogue } from './types';

const who = `${E.legalName} ("${E.brand}", "we")`;

export const en: LegalCatalogue = {
  privacy: {
    title: 'Privacy policy',
    summary: `What data ${E.brand} processes, why, who it is shared with and how to exercise your rights.`,
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [
          `${who}, based in ${E.city}, ${E.country.en}, provides ${E.brand} at ${E.site}: a platform for businesses to serve their customers over WhatsApp. For any privacy matter write to ${E.email}.`,
        ],
      },
      {
        heading: 'Two different roles',
        paragraphs: [
          'For the data of the people who use the dashboard (owners, admins and agents of an account), we act as data controller.',
          'For the data of the end customers each business talks to over WhatsApp, the business is the controller and we act as processor: we process it only to provide the service and on the business’s instructions.',
        ],
      },
      {
        heading: 'Data we process',
        bullets: [
          'Account data: name, email, hashed password, role and company.',
          'WhatsApp Business data the business connects: account and phone number identifiers, and access tokens, which we store encrypted.',
          'Conversation content: messages, attachments, contacts (name, phone number or WhatsApp user id), tags and notes.',
          'Billing data: plan, subscription status and PayPal identifiers. We never receive or store card numbers.',
          'Technical data: access logs, IP address and API usage, for security and to apply each plan’s limits.',
        ],
      },
      {
        heading: 'What we use it for',
        bullets: [
          'Providing the service: sending and receiving messages, the inbox, automations and broadcasts.',
          'Generating AI replies when the business turns that feature on.',
          'Charging the subscription and applying the plan’s limits.',
          'Keeping the service secure, preventing abuse and providing support.',
          'Meeting legal obligations.',
        ],
        paragraphs: [
          'We do not sell personal data or use it for advertising. We do not use conversation content to train AI models.',
        ],
      },
      {
        heading: 'Who we share it with',
        paragraphs: [
          'Only with the providers we need to run the service, each limited to its function:',
        ],
        bullets: [
          'Meta Platforms (WhatsApp Business API): to send and receive messages.',
          'Supabase: database, authentication and file storage.',
          'PayPal: payment processing.',
          'OpenAI and Anthropic: only if the business enables AI replies; they receive the part of the conversation needed to generate the reply.',
          'Hosting providers for the application server.',
        ],
      },
      {
        heading: 'Data from Meta platforms',
        paragraphs: [
          'When a business connects its WhatsApp Business account through Meta’s embedded signup, we receive the permissions it authorises (whatsapp_business_management and whatsapp_business_messaging). We use them only to manage its phone numbers and templates and to send and receive its messages. We do not use them for any other purpose or share them with third parties beyond what this policy describes.',
        ],
      },
      {
        heading: 'How long we keep it',
        paragraphs: [
          'We keep data while the account is active. If the business cancels and asks for deletion, we delete its data within 30 days at most, except what we must keep by law (for example, billing records).',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'All communications are encrypted in transit and WhatsApp tokens are stored encrypted. Each business’s data is isolated per account and, within it, by each user’s role.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          `You can request access, correction, deletion or objection to the processing of your data by writing to ${E.email}. If you are an end customer of a business that uses ${E.brand}, contact that business first, as it controls your data; if you write to us, we will forward the request.`,
          'Deletion instructions are on the "Data deletion" page.',
        ],
      },
      {
        heading: 'Changes to this policy',
        paragraphs: [
          'If we change this policy in a meaningful way we will announce it in the dashboard or by email before it takes effect.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of service',
    summary: `Terms of use of ${E.brand}.`,
    sections: [
      {
        heading: 'Acceptance',
        paragraphs: [
          `These terms govern the use of ${E.brand}, a service provided by ${E.legalName} at ${E.site}. By creating an account or using the service you accept them on your own behalf and on behalf of the business you represent.`,
        ],
      },
      {
        heading: 'The service',
        paragraphs: [
          `${E.brand} is a platform to manage WhatsApp Business conversations: shared inbox, contacts, automations, broadcasts, AI replies and an API for integrations. Features and limits depend on the plan.`,
        ],
      },
      {
        heading: 'Your account',
        bullets: [
          'You must provide accurate information and keep your password and API keys secure.',
          'You are responsible for what the users you invite to your account do.',
          'You must have legal capacity to contract on behalf of your business.',
        ],
      },
      {
        heading: 'Use of WhatsApp',
        paragraphs: [
          'To use the service you need your own WhatsApp Business account. By using it through us you agree to comply with the WhatsApp Business Terms, the WhatsApp Business Messaging Policy and Meta’s commerce policies.',
        ],
        bullets: [
          'You may only message people who have agreed to receive your messages.',
          'You may not send spam or content that is illegal, misleading or infringes third-party rights.',
          'Meta bills conversations directly to your WhatsApp Business account at its rates; that charge is separate from your subscription.',
          'Meta may limit or suspend your number for breaching its policies; that is outside our control.',
        ],
      },
      {
        heading: 'Plans, payments and cancellation',
        bullets: [
          'The subscription is charged in advance, monthly or yearly, through PayPal, at the price shown in the dashboard.',
          'You can cancel at any time from Settings → Subscription; cancellation takes effect at the end of the period already paid.',
          'We do not refund partial periods unless the law requires it.',
          'If a payment fails, the account may become read-only until it is settled.',
        ],
      },
      {
        heading: 'Your data',
        paragraphs: [
          'The data you upload and the conversations with your customers are yours. We process them to provide the service under our Privacy policy. You can export them from the dashboard or the API while the account is active.',
        ],
      },
      {
        heading: 'Prohibited use',
        bullets: [
          'Trying to access other accounts’ data or bypass limits and security measures.',
          'Using the service for illegal activity or to send unsolicited communications.',
          'Reselling the service without a written agreement with us.',
        ],
      },
      {
        heading: 'Availability and liability',
        paragraphs: [
          'We work to keep the service available at all times, but it is provided "as is", without a guarantee of uninterrupted operation. We rely on third-party services (Meta, PayPal, hosting and AI providers) whose outages we do not control.',
          'To the extent permitted by law, our total liability to you is limited to what you paid for the service in the 12 months before the event giving rise to it.',
        ],
      },
      {
        heading: 'Suspension and termination',
        paragraphs: [
          'We may suspend or close an account that breaches these terms or Meta’s policies. You can close your account at any time by following the "Data deletion" instructions.',
        ],
      },
      {
        heading: 'Changes and governing law',
        paragraphs: [
          `We may update these terms; we will give notice of meaningful changes in advance. They are governed by the laws of the ${E.country.en}.`,
          `Contact: ${E.email}.`,
        ],
      },
    ],
  },

  'data-deletion': {
    title: 'Data deletion',
    summary: `How to delete your data from ${E.brand}.`,
    sections: [
      {
        heading: 'If you have a Cabbity CRM account',
        paragraphs: [
          'You can delete individual contacts and conversations from the dashboard. To delete the whole account and all its data:',
        ],
        bullets: [
          'Cancel the subscription in Settings → Subscription, if you have an active one.',
          `Write to ${E.email} from the account owner’s email with the subject "Delete account".`,
          'We will confirm the request and delete the data within 30 days at most, except what we must keep by law.',
        ],
      },
      {
        heading: 'If you connected your account with Facebook',
        paragraphs: [
          'You can remove Cabbity’s access from Facebook under Settings → Business integrations, or from Meta Business Suite under Settings → Integrations → Connected apps. Once removed we can no longer send or receive messages with your number. To also delete the data we already store, follow the steps above.',
        ],
      },
      {
        heading: 'If you are an end customer of a business',
        paragraphs: [
          `If you chatted on WhatsApp with a business that uses ${E.brand}, that business controls your data: ask it to delete it. You can also write to us at ${E.email} with the phone number and the business, and we will forward the request.`,
        ],
      },
    ],
  },
};
