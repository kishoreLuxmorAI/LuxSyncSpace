import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import { DeepgramClient } from "@deepgram/sdk";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { workspaceRouter } from "./routes/workspace.js";
import { provisioningRouter } from "./routes/provisioning.js";
import { startEventReminderScheduler } from "./services/eventReminders.js";
import { sql } from "./db/client.js";
import { cached, invalidateCache } from "./services/cache.js";

const app = express();
const server = http.createServer(app);
function allowOrigin(origin, callback) {
  const normalizedOrigin = String(origin || "").replace(/\/+$/, "");
  const allowed = !origin
    || config.clientUrls.includes(normalizedOrigin)
    || (config.allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin));
  callback(null, allowed);
}

const corsOptions = {
  origin: allowOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"]
};
const io = new Server(server, { cors: corsOptions });
const deepgram = config.deepgramApiKey ? new DeepgramClient({ apiKey: config.deepgramApiKey }) : null;
if (config.redisUrl) {
  const redisOptions = { maxRetriesPerRequest: null, enableReadyCheck: false };
  const pubClient = new Redis(config.redisUrl, redisOptions);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  pubClient.on("error", (error) => console.error("Redis publisher error", error.message));
  subClient.on("error", (error) => console.error("Redis subscriber error", error.message));
}
app.set("io", io);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: "1mb" }));
if (process.env.NODE_ENV !== "production") app.use(morgan("dev"));

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  service: "luxsyncspace-api",
  realtime: config.redisUrl ? "redis-coordinated" : "single-instance"
}));
app.use("/api/provisioning", provisioningRouter);
app.use("/api/auth", authRouter);
app.use("/api", workspaceRouter);

io.use(async (socket, next) => {
  try {
    socket.auth = jwt.verify(socket.handshake.auth.token, config.jwtSecret);
    const [account] = await sql`SELECT employment_status FROM users WHERE id = ${socket.auth.userId}`;
    if (!account || (account.employment_status || "active") !== "active") return next(new Error("account_inactive"));
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});
io.on("connection", (socket) => {
  socket.data.captionSessions = new Map();
  function closeCaptionSession(sourceSocketId) {
    const session = socket.data.captionSessions.get(sourceSocketId);
    if (!session) return;
    socket.data.captionSessions.delete(sourceSocketId);
    session.connection?.close();
  }

  function closeAllCaptionSessions() {
    for (const sourceSocketId of socket.data.captionSessions.keys()) closeCaptionSession(sourceSocketId);
  }

  socket.join(`user:${socket.auth.userId}`);
  socket.join(`org:${socket.auth.organizationId}`);
  cached(`socket-memberships:${socket.auth.organizationId}`, 10_000, () =>
    sql`SELECT user_id, channel_id FROM channel_members cm
        JOIN channels c ON c.id = cm.channel_id
        WHERE c.organization_id = ${socket.auth.organizationId}`
  )
    .then((memberships) => socket.join(
      memberships
        .filter((membership) => membership.user_id === socket.auth.userId)
        .map((membership) => `channel:${membership.channel_id}`)
    ))
    .catch((error) => console.error("Could not join channel rooms", error));
  socket.on("channel:join", async (channelId) => {
    const [membership] = await sql`
      SELECT 1 FROM channel_members cm
      JOIN channels c ON c.id = cm.channel_id
      WHERE cm.channel_id = ${channelId} AND cm.user_id = ${socket.auth.userId}
        AND c.organization_id = ${socket.auth.organizationId}
    `;
    if (membership) socket.join(`channel:${channelId}`);
  });
  socket.on("channel:leave", (channelId) => socket.leave(`channel:${channelId}`));

  socket.on("meeting:presence", async ({ roomId }, acknowledge = () => {}) => {
    try {
      const [meeting] = await sql`
        SELECT id, cancelled_at, ended_at FROM events
        WHERE id = ${roomId}
          AND organization_id = ${socket.auth.organizationId}
          AND is_online = TRUE
      `;
      if (!meeting) return acknowledge({ ok: false, error: "Meeting not found or access denied" });
      if (meeting.cancelled_at) return acknowledge({ ok: false, error: "This meeting was cancelled", cancelled: true });
      if (meeting.ended_at) return acknowledge({ ok: false, error: "This call has ended", ended: true });

      const participants = await io.in(`meeting:${meeting.id}`).fetchSockets();
      acknowledge({
        ok: true,
        participants: participants
          .filter((participant) => participant.data.meetingProfile)
          .map((participant) => participant.data.meetingProfile)
      });
    } catch (error) {
      console.error("Meeting presence lookup failed", error);
      acknowledge({ ok: false, error: "Could not check meeting participants" });
    }
  });

  socket.on("meeting:join", async ({ roomId }, acknowledge = () => {}) => {
    try {
      const [joinData] = await sql`
        SELECT
          event.id AS meeting_id,
          event.title AS meeting_title,
          event.organizer_id,
          event.starts_at,
          event.ends_at,
          event.cancelled_at,
          event.ended_at,
          profile.id AS profile_id,
          CASE WHEN profile.hide_full_name
              THEN COALESCE(NULLIF(profile.display_name, ''), 'Team member')
              ELSE profile.full_name
          END AS profile_full_name,
          profile.title AS profile_title,
          profile.initials AS profile_initials,
          profile.avatar_color AS profile_avatar_color,
          profile.availability_status AS profile_availability_status
        FROM events AS event
        JOIN users AS profile ON profile.id = ${socket.auth.userId}
        WHERE event.id = ${roomId}
          AND event.organization_id = ${socket.auth.organizationId}
          AND event.is_online = TRUE
      `;
      if (!joinData) return acknowledge({ ok: false, error: "Meeting not found or access denied" });
      if (joinData.cancelled_at) return acknowledge({ ok: false, error: "This meeting was cancelled", cancelled: true });
      if (joinData.ended_at) return acknowledge({ ok: false, error: "This call has ended", ended: true });
      const meeting = {
        id: joinData.meeting_id,
        title: joinData.meeting_title,
        organizer_id: joinData.organizer_id,
        starts_at: joinData.starts_at,
        ends_at: joinData.ends_at
      };
      const profile = {
        id: joinData.profile_id,
        full_name: joinData.profile_full_name,
        title: joinData.profile_title,
        initials: joinData.profile_initials,
        avatar_color: joinData.profile_avatar_color
      };
      if (socket.meetingRoom) {
        socket.leave(socket.meetingRoom);
        socket.to(socket.meetingRoom).emit("meeting:user-left", { socketId: socket.id });
      }
      const room = `meeting:${meeting.id}`;
      const existingSockets = await io.in(room).fetchSockets();
      const attendeeRows = await sql`
        SELECT user_id FROM event_attendees
        WHERE event_id = ${meeting.id} AND user_id <> ${meeting.organizer_id}
      `;
      const attendeeIds = new Set(attendeeRows.map((attendee) => attendee.user_id));
      if (!socket.meetingRoom) {
        socket.data.meetingPreviousAvailabilityStatus = joinData.profile_availability_status;
      }
      const [updatedPresence] = await sql`
        UPDATE users SET availability_status = 'meeting'
        WHERE id = ${socket.auth.userId} AND organization_id = ${socket.auth.organizationId}
          AND availability_status <> 'meeting'
        RETURNING id, presence, availability_status
      `;
      if (updatedPresence) {
        invalidateCache(`people:${socket.auth.organizationId}`);
        io.to(`org:${socket.auth.organizationId}`).emit("presence:updated", updatedPresence);
      }
      socket.meetingRoom = room;
      socket.data.meetingProfile = profile;
      socket.join(room);
      acknowledge({
        ok: true,
        meeting,
        participants: existingSockets.map((participant) => ({
          socketId: participant.id,
          user: participant.data.meetingProfile
        })).filter((participant) => participant.user)
      });
      socket.to(room).emit("meeting:user-joined", { socketId: socket.id, user: profile });
      const roomSockets = await io.in(room).fetchSockets();
      const roomProfiles = roomSockets
        .map((participant) => participant.data.meetingProfile)
        .filter(Boolean);
      const organizerPresent = roomProfiles.some((participant) => participant.id === meeting.organizer_id);
      const inviteePresent = roomProfiles.some((participant) => attendeeIds.has(participant.id));
      if (organizerPresent && inviteePresent) {
        const notifiedUserIds = new Set([meeting.organizer_id, ...attendeeIds]);
        for (const userId of notifiedUserIds) {
          io.to(`user:${userId}`).emit("call:answered", {
            meetingId: meeting.id,
            participant: profile
          });
        }
      }
    } catch (error) {
      console.error("Meeting join failed", error);
      acknowledge({ ok: false, error: "Could not join this meeting" });
    }
  });

  socket.on("meeting:signal", async ({ target, signal }) => {
    const [targetSocket] = await io.in(target).fetchSockets();
    if (!socket.meetingRoom || !targetSocket?.rooms.has(socket.meetingRoom)) return;
    io.to(target).emit("meeting:signal", { from: socket.id, signal, user: socket.data.meetingProfile });
  });

  socket.on("meeting:captions:start", async (payload = {}, acknowledge = () => {}) => {
    const sourceSocketId = payload?.sourceSocketId;
    const acknowledgeResult = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      if (!socket.meetingRoom || typeof sourceSocketId !== "string" || sourceSocketId === socket.id) {
        return acknowledgeResult({ ok: false, error: "Could not start captions for this participant." });
      }
      if (!deepgram) {
        return acknowledgeResult({ ok: false, code: "CAPTIONS_UNAVAILABLE", error: "Live captions are not configured. Set DEEPGRAM_API_KEY on the server." });
      }
      const existing = socket.data.captionSessions.get(sourceSocketId);
      if (existing) return acknowledgeResult({ ok: true });

      if (socket.data.captionSessions.size >= 12) {
        return acknowledgeResult({ ok: false, error: "Captions support up to 12 other participants at a time." });
      }

      const session = { connection: null, speakerName: "Participant", ready: false };
      socket.data.captionSessions.set(sourceSocketId, session);
      const roomId = socket.meetingRoom;
      const roomParticipants = await io.in(roomId).fetchSockets();
      const source = roomParticipants.find((participant) => participant.id === sourceSocketId);
      if (!source?.data.meetingProfile || socket.data.captionSessions.get(sourceSocketId) !== session) {
        closeCaptionSession(sourceSocketId);
        return acknowledgeResult({ ok: false, error: "This participant is no longer connected." });
      }
      session.speakerName = source.data.meetingProfile.full_name || "Participant";

      const connection = await deepgram.listen.v1.connect({
        model: "nova-3",
        language: "en-US",
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
        interim_results: "true",
        smart_format: "true"
      });
      if (!socket.connected || socket.data.captionSessions.get(sourceSocketId) !== session) {
        connection.close();
        return acknowledgeResult({ ok: false, error: "The caption stream was closed before it connected." });
      }
      session.connection = connection;

      connection.on("message", (message) => {
        if (message.type === "Error") {
          console.error("Deepgram returned a caption error", message.description);
          closeCaptionSession(sourceSocketId);
          socket.emit("meeting:captions:error", {
            sourceSocketId,
            terminal: true,
            error: "Live transcription rejected this audio stream. Turn CC off and on to retry."
          });
          return;
        }
        if (message.type !== "Results") return;
        const transcript = message.channel?.alternatives?.[0]?.transcript?.trim();
        if (!transcript || socket.data.captionSessions.get(sourceSocketId) !== session) return;
        socket.emit("meeting:captions:transcript", {
          sourceSocketId,
          speakerName: session.speakerName,
          transcript,
          isFinal: Boolean(message.is_final || message.speech_final)
        });
      });
      connection.on("open", () => {
        if (socket.data.captionSessions.get(sourceSocketId) === session) session.ready = true;
      });
      connection.on("error", (error) => {
        console.error("Deepgram live caption stream error", error);
        if (session.ready && socket.connected && socket.data.captionSessions.get(sourceSocketId) === session) {
          socket.emit("meeting:captions:error", { sourceSocketId, error: "Live captions temporarily lost their transcription connection." });
        }
      });
      connection.on("close", () => {
        if (socket.data.captionSessions.get(sourceSocketId) !== session) return;
        session.ready = false;
        if (socket.connected) socket.emit("meeting:captions:error", { sourceSocketId, error: "Live captions lost their transcription connection and are reconnecting." });
      });

      connection.connect();
      let timeout;
      try {
        await Promise.race([
          connection.waitForOpen(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Deepgram connection timed out")), 10_000);
          })
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (!socket.connected || socket.data.captionSessions.get(sourceSocketId) !== session) {
        closeCaptionSession(sourceSocketId);
        return acknowledgeResult({ ok: false, error: "The caption stream was closed before it connected." });
      }
      session.ready = true;
      acknowledgeResult({ ok: true });
    } catch (error) {
      closeCaptionSession(sourceSocketId);
      console.error("Could not start Deepgram caption stream", error);
      acknowledgeResult({ ok: false, error: "Could not connect to live speech transcription. Please try CC again." });
    }
  });

  socket.on("meeting:captions:audio", (payload = {}) => {
    const { sourceSocketId, audio } = payload || {};
    if (!socket.meetingRoom || typeof sourceSocketId !== "string") return;
    const session = socket.data.captionSessions.get(sourceSocketId);
    if (!session?.ready || session.connection.readyState !== 1) return;
    let buffer;
    if (Buffer.isBuffer(audio)) buffer = audio;
    else if (audio instanceof ArrayBuffer) buffer = Buffer.from(audio);
    else if (ArrayBuffer.isView(audio)) buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    else return;
    if (buffer.length === 0 || buffer.length > 8192) return;
    try {
      if (session.connection.socket.bufferedAmount > 262144) return;
      session.connection.sendMedia(buffer);
    } catch (error) {
      console.error("Could not forward audio to Deepgram", error);
      socket.emit("meeting:captions:error", { sourceSocketId, error: "Live captions could not process this participant's audio." });
    }
  });

  socket.on("meeting:captions:stop", (payload = {}) => {
    const { sourceSocketId } = payload || {};
    if (typeof sourceSocketId === "string") closeCaptionSession(sourceSocketId);
  });

  socket.on("meeting:chat", ({ body }) => {
    const message = String(body || "").trim().slice(0, 2000);
    if (!socket.meetingRoom || !message) return;
    io.to(socket.meetingRoom).emit("meeting:chat", {
      id: crypto.randomUUID(),
      body: message,
      sender_id: socket.auth.userId,
      sender_name: socket.data.meetingProfile?.full_name || "Participant",
      sent_at: new Date().toISOString()
    });
  });

  socket.on("meeting:hand", ({ raised }) => {
    if (socket.meetingRoom) socket.to(socket.meetingRoom).emit("meeting:hand", { socketId: socket.id, raised: Boolean(raised) });
  });

  async function handleMeetingExit() {
    if (!socket.meetingRoom) return;
    closeAllCaptionSessions();
    const room = socket.meetingRoom;
    socket.to(room).emit("meeting:user-left", { socketId: socket.id });
    socket.leave(room);
    socket.meetingRoom = null;
    socket.data.meetingProfile = null;

    try {
      const previousAvailabilityStatus = socket.data.meetingPreviousAvailabilityStatus;
      socket.data.meetingPreviousAvailabilityStatus = null;
      if (previousAvailabilityStatus) {
        const [updatedPresence] = await sql`
          UPDATE users SET availability_status = ${previousAvailabilityStatus}
          WHERE id = ${socket.auth.userId} AND organization_id = ${socket.auth.organizationId}
            AND availability_status = 'meeting'
          RETURNING id, presence, availability_status
        `;
        if (updatedPresence) {
          invalidateCache(`people:${socket.auth.organizationId}`);
          io.to(`org:${socket.auth.organizationId}`).emit("presence:updated", updatedPresence);
        }
      }

      const roomId = room.replace("meeting:", "");
      const remainingSockets = await io.in(room).fetchSockets();
      const remainingProfiles = remainingSockets.filter((s) => s.data.meetingProfile);
      const [event] = await sql`
        SELECT id, title, organizer_id, meeting_mode, organization_id, ended_at, cancelled_at
        FROM events WHERE id = ${roomId}
      `;
      if (!event || event.ended_at || event.cancelled_at) return;

      const attendeeRows = await sql`
        SELECT user_id FROM event_attendees
        WHERE event_id = ${roomId} AND user_id <> ${event.organizer_id}
      `;
      const isDirectCall = (event.title && event.title.includes(" and ")) || attendeeRows.length === 1;

      // If room is completely empty, or if it was a 1-on-1 direct call and one person leaves
      if (remainingProfiles.length === 0 || (isDirectCall && remainingProfiles.length <= 1)) {
        const [ended] = await sql`
          UPDATE events
          SET ended_at = NOW(),
              ends_at = GREATEST(starts_at + INTERVAL '1 minute', LEAST(ends_at, NOW()))
          WHERE id = ${roomId} AND ended_at IS NULL
          RETURNING id, title, meeting_mode, organization_id, ended_at
        `;
        if (ended) {
          const isCall = ended.meeting_mode === "audio" || (ended.title || "").toLowerCase().includes("call") || (ended.title || "").includes(" and ");
          const endMessage = isCall ? "Call ended." : "Meeting ended.";
          io.to(room).emit("meeting:ended", {
            event_id: ended.id,
            message: endMessage,
            isCall
          });
          io.in(room).socketsLeave(room);
          io.to(`org:${ended.organization_id}`).emit("event:ended", {
            event_id: ended.id,
            ended_at: ended.ended_at,
            title: ended.title,
            isCall
          });
          invalidateCache(`events:${ended.organization_id}`);
        }
      }
    } catch (err) {
      console.error("Meeting exit auto-end error:", err.message);
    }
  }

  socket.on("meeting:leave", handleMeetingExit);
  socket.on("disconnecting", handleMeetingExit);
});
startEventReminderScheduler(io);

if (!process.env.VERCEL) {
  const clientDist = path.join(config.root, "apps/client/dist");
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDist, "index.html"), (error) => error && next());
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error?.name === "ZodError") return res.status(400).json({ error: error.issues[0]?.message || "Invalid request" });
  const status = error.status || 500;
  const networkFailure = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo/i.test(`${error.code || ""} ${error.message || ""}`);
  const message = networkFailure
    ? "Unable to connect to the server. Please check your internet connection and try again."
    : status < 500
      ? error.message
      : "Something went wrong. Please try again.";
  res.status(status).json({ error: message });
});

if (!process.env.VERCEL) {
  server.listen(config.port, () => console.log(`LuxSyncspace API listening on http://localhost:${config.port}`));
}

export default server;
