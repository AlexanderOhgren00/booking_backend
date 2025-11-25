import nodemailer from 'nodemailer';
import db from './db/connections.js';

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  host: "mailcluster.loopia.se",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

/**
 * Sends critical alerts via multiple channels (email, Slack, database)
 * @param {Object} alert - Alert object containing details about the critical issue
 */
async function sendCriticalAlert(alert) {
  console.log('Sending critical alert:', alert);

  // Email notification
  try {
    const emailSubject = `🚨 CRITICAL ALERT: ${alert.type}`;
    const emailBody = `
      <h2 style="color: red;">🚨 CRITICAL BOOKING SYSTEM ALERT</h2>

      <h3>Alert Type: ${alert.type}</h3>
      <p><strong>Severity:</strong> ${alert.severity || 'CRITICAL'}</p>
      <p><strong>Time:</strong> ${alert.timestamp || new Date()}</p>

      <h3>Details:</h3>
      <ul>
        ${alert.paymentId ? `<li><strong>Payment ID:</strong> ${alert.paymentId}</li>` : ''}
        ${alert.amount ? `<li><strong>Amount:</strong> ${alert.amount} ${alert.currency || 'SEK'}</li>` : ''}
        ${alert.paymentMethod ? `<li><strong>Payment Method:</strong> ${alert.paymentMethod}</li>` : ''}
        ${alert.customerEmail ? `<li><strong>Customer Email:</strong> ${alert.customerEmail}</li>` : ''}
        ${alert.customerName ? `<li><strong>Customer Name:</strong> ${alert.customerName}</li>` : ''}
        ${alert.payerAlias ? `<li><strong>Payer:</strong> ${alert.payerAlias}</li>` : ''}
      </ul>

      <h3>Message:</h3>
      <p>${alert.message}</p>

      ${alert.instructions ? `
        <h3>Action Required:</h3>
        <ol>
          ${alert.instructions.map(instr => `<li>${instr}</li>`).join('')}
        </ol>
      ` : ''}

      ${alert.failedRecoveries ? `
        <h3>Failed Recoveries:</h3>
        <pre>${JSON.stringify(alert.failedRecoveries, null, 2)}</pre>
      ` : ''}

      ${alert.webhook ? `
        <h3>Webhook Data:</h3>
        <pre>${JSON.stringify(alert.webhook, null, 2)}</pre>
      ` : ''}

      <hr>
      <p><em>This is an automated alert from the Mint Escape Room booking system.</em></p>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ADMIN_ALERT_EMAIL || process.env.EMAIL_USER,
      subject: emailSubject,
      html: emailBody
    });

    console.log('✅ Critical alert email sent');
  } catch (emailError) {
    console.error('❌ Failed to send alert email:', emailError);
  }

  // Slack notification (optional)
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 CRITICAL ALERT: ${alert.type}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `🚨 ${alert.type}`,
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Payment ID:*\n${alert.paymentId || 'N/A'}` },
                { type: 'mrkdwn', text: `*Amount:*\n${alert.amount || 'N/A'} SEK` },
                { type: 'mrkdwn', text: `*Customer:*\n${alert.customerEmail || 'N/A'}` },
                { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleString('sv-SE')}` }
              ]
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Message:*\n${alert.message}`
              }
            }
          ]
        })
      });

      console.log('✅ Slack alert sent');
    } catch (slackError) {
      console.error('❌ Failed to send Slack alert:', slackError);
    }
  }

  // Database logging
  try {
    await db.collection('critical_alerts').insertOne({
      ...alert,
      createdAt: new Date(),
      acknowledged: false
    });
    console.log('✅ Alert logged to database');
  } catch (dbError) {
    console.error('❌ Failed to log alert to database:', dbError);
  }
}

export { sendCriticalAlert };
