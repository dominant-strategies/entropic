import { open } from "@tauri-apps/plugin-shell";
import { getAccessToken } from "./auth";

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || "";

// Supabase Edge Functions base URL
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export type IntegrationProvider =
  | 'google_calendar'
  | 'google_email'
  | 'google_calendar_email';

export interface Integration {
  provider: string;
  connected: boolean;
  email?: string;
  scopes: string[];
}

/**
 * Make authenticated request to Supabase Edge Function
 */
async function functionRequest<T>(
  functionName: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${FUNCTIONS_URL}/${functionName}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Get user's connected integrations
 */
export async function getIntegrations(): Promise<Integration[]> {
  const response = await functionRequest<{ integrations: Integration[] }>('integrations');
  return response.integrations;
}

/**
 * Check if a specific integration is connected
 */
export async function isIntegrationConnected(provider: IntegrationProvider): Promise<boolean> {
  const integrations = await getIntegrations();
  return integrations.some(i => i.provider === provider && i.connected);
}

/**
 * Start OAuth flow to connect an integration
 * Opens the system browser for OAuth
 */
export async function connectIntegration(
  provider: IntegrationProvider,
  redirectUri?: string
): Promise<void> {
  const response = await functionRequest<{ url: string }>('integrations', {
    method: 'POST',
    body: JSON.stringify({
      provider,
      redirect_uri: redirectUri || 'nova://integrations/success'
    }),
  });

  // Open OAuth URL in system browser
  await open(response.url);
}

/**
 * Disconnect an integration
 */
export async function disconnectIntegration(provider: IntegrationProvider): Promise<void> {
  await functionRequest('integrations-disconnect', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

/**
 * Get a valid access token for an integration
 * Use this to make API calls to the integrated service
 */
export async function getIntegrationToken(provider: IntegrationProvider): Promise<string> {
  const response = await functionRequest<{ access_token: string }>('integrations-token', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
  return response.access_token;
}

// =============================================================================
// Helper functions for using integrations
// =============================================================================

/**
 * Fetch Google Calendar events
 */
export async function fetchCalendarEvents(
  timeMin?: Date,
  timeMax?: Date,
  maxResults = 10
): Promise<any[]> {
  const token = await getIntegrationToken('google_calendar');

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  if (timeMin) {
    params.set('timeMin', timeMin.toISOString());
  }
  if (timeMax) {
    params.set('timeMax', timeMax.toISOString());
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status}`);
  }

  const data = await response.json();
  return data.items || [];
}

/**
 * Create a Google Calendar event
 */
export async function createCalendarEvent(event: {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: { email: string }[];
}): Promise<any> {
  const token = await getIntegrationToken('google_calendar');

  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch Gmail messages
 */
export async function fetchEmails(
  query?: string,
  maxResults = 10
): Promise<any[]> {
  const token = await getIntegrationToken('google_email');

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
  });

  if (query) {
    params.set('q', query);
  }

  // First get message IDs
  const listResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!listResponse.ok) {
    throw new Error(`Gmail API error: ${listResponse.status}`);
  }

  const listData = await listResponse.json();
  const messages = listData.messages || [];

  // Fetch full message details for each
  const fullMessages = await Promise.all(
    messages.slice(0, maxResults).map(async (msg: { id: string }) => {
      const msgResponse = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      return msgResponse.json();
    })
  );

  return fullMessages;
}

/**
 * Send an email via Gmail
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<any> {
  const token = await getIntegrationToken('google_email');

  // Create email in RFC 2822 format
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  // Base64 encode
  const encodedEmail = btoa(email)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch(
    'https://www.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedEmail }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status}`);
  }

  return response.json();
}
