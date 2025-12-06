import * as functions from 'firebase-functions';

// SendGrid will be configured via Firebase Functions config
// Run: firebase functions:config:set sendgrid.key="YOUR_API_KEY" sendgrid.from="your-email@domain.com"

interface EmailConfig {
  apiKey: string;
  fromEmail: string;
  appName: string;
  appUrl: string;
}

/**
 * Get email configuration from Firebase Functions config
 */
function getEmailConfig(): EmailConfig {
  const config = functions.config();
  return {
    apiKey: config.sendgrid?.key || '',
    fromEmail: config.sendgrid?.from || 'noreply@todoplannerapp.com',
    appName: config.app?.name || 'TODO Planner',
    appUrl: config.app?.url || 'https://todoplannerapp.com',
  };
}

/**
 * Check if email service is configured
 */
export function isEmailConfigured(): boolean {
  const config = getEmailConfig();
  return config.apiKey.length > 0;
}

/**
 * Send an invite email to a user
 * @param toEmail - Recipient email address
 * @param inviterName - Name of the person sending the invite
 * @param token - Unique invite token
 * @param teamName - Optional team name if inviting to a specific team
 */
export async function sendInviteEmail(
  toEmail: string,
  inviterName: string,
  token: string,
  teamName?: string
): Promise<boolean> {
  const config = getEmailConfig();

  if (!config.apiKey) {
    console.warn('SendGrid API key not configured. Email not sent.');
    console.log(`[DEV] Invite email would be sent to: ${toEmail}`);
    console.log(`[DEV] Invite token: ${token}`);
    // Return true in dev mode to allow testing without email
    return true;
  }

  try {
    // Dynamic import to avoid issues when SendGrid is not installed
    const sgMail = await import('@sendgrid/mail');
    sgMail.default.setApiKey(config.apiKey);

    // Play Store link placeholder - replace with actual link
    const playStoreLink = 'https://play.google.com/store/apps/details?id=com.yourapp.todo';
    const teamMessage = teamName
      ? ` to join the "${teamName}" team`
      : '';

    const msg = {
      to: toEmail,
      from: {
        email: config.fromEmail,
        name: config.appName,
      },
      subject: `You're invited to ${config.appName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Invitation to ${config.appName}</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">${config.appName}</h1>
          </div>
          
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">You're Invited! 🎉</h2>
            
            <p style="font-size: 16px; color: #555;">
              <strong>${inviterName}</strong> has invited you${teamMessage} on ${config.appName} - 
              a task management app to help you stay organized and productive.
            </p>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
              <h3 style="margin-top: 0; color: #667eea; font-size: 18px;">📱 Next Steps:</h3>
              <ol style="margin: 10px 0; padding-left: 20px; color: #555;">
                <li style="margin: 8px 0;">Download the app from Play Store</li>
                <li style="margin: 8px 0;">Sign up using this email: <strong>${toEmail}</strong></li>
                <li style="margin: 8px 0;">You'll be automatically approved!</li>
              </ol>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${playStoreLink}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 14px 30px; 
                        text-decoration: none; 
                        border-radius: 8px; 
                        font-weight: bold; 
                        font-size: 16px;
                        display: inline-block;">
                Download from Play Store
              </a>
            </div>
            
            <p style="font-size: 14px; color: #777;">
              This invitation will expire in 7 days.
            </p>
            
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 25px 0;">
            
            <p style="font-size: 12px; color: #999; margin-bottom: 0;">
              If you didn't expect this invitation, you can safely ignore this email.
            </p>
          </div>
          
          <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
            <p>© ${new Date().getFullYear()} ${config.appName}. All rights reserved.</p>
          </div>
        </body>
        </html>
      `,
      text: `
${inviterName} has invited you${teamMessage} on ${config.appName}!

Next Steps:
1. Download the app from Play Store: ${playStoreLink}
2. Sign up using this email: ${toEmail}
3. You'll be automatically approved!

This invitation will expire in 7 days.

If you didn't expect this invitation, you can safely ignore this email.
      `.trim(),
    };

    await sgMail.default.send(msg);
    console.log(`Invite email sent to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('Failed to send invite email:', error);
    return false;
  }
}

/**
 * Send invite accepted notification to the inviter
 * @param toEmail - Inviter's email address
 * @param invitedEmail - Email of the person who accepted
 * @param invitedName - Name of the person who accepted
 */
export async function sendInviteAcceptedEmail(
  toEmail: string,
  invitedEmail: string,
  invitedName: string
): Promise<boolean> {
  const config = getEmailConfig();

  if (!config.apiKey) {
    console.warn('SendGrid API key not configured. Email not sent.');
    return true;
  }

  try {
    const sgMail = await import('@sendgrid/mail');
    sgMail.default.setApiKey(config.apiKey);

    const msg = {
      to: toEmail,
      from: {
        email: config.fromEmail,
        name: config.appName,
      },
      subject: `${invitedName} has joined ${config.appName}!`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Invitation Accepted</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">${config.appName}</h1>
          </div>
          
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Invitation Accepted! ✅</h2>
            
            <p style="font-size: 16px; color: #555;">
              Great news! <strong>${invitedName}</strong> (${invitedEmail}) has accepted your invitation 
              and joined ${config.appName}.
            </p>
            
            <p style="font-size: 14px; color: #777;">
              You can now assign tasks and collaborate with them.
            </p>
          </div>
        </body>
        </html>
      `,
      text: `${invitedName} (${invitedEmail}) has accepted your invitation and joined ${config.appName}!`,
    };

    await sgMail.default.send(msg);
    return true;
  } catch (error) {
    console.error('Failed to send invite accepted email:', error);
    return false;
  }
}
