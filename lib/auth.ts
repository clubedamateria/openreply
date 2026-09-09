import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import Resend from "next-auth/providers/resend";
import Credentials from "next-auth/providers/credentials";
import { timingSafeEqual } from "node:crypto";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";
// Setting EMAIL_SERVER switches magic links to your own SMTP server, for
// self-hosters who do not want a third-party mail service. Resend stays the
// default, so an existing deployment is unaffected.
const smtpServer = process.env.EMAIL_SERVER;

/**
 * Provider id the login form has to sign in with. It differs per transport,
 * so it is derived here rather than hardcoded at the call site.
 */
export const EMAIL_PROVIDER_ID = smtpServer ? "nodemailer" : "resend";

// Self-hosted, single-owner mode: ADMIN_EMAIL + ADMIN_PASSWORD replace the
// magic link entirely, so no mail service is needed. The User row is upserted
// on first sign-in and the session lives in a JWT (Credentials cannot use the
// database session strategy).
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
export const PASSWORD_LOGIN = Boolean(adminEmail && adminPassword);

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: PASSWORD_LOGIN
    ? [
        Credentials({
          credentials: {
            email: { label: "Email", type: "email" },
            password: { label: "Password", type: "password" },
          },
          async authorize(credentials) {
            const email = String(credentials?.email ?? "").trim().toLowerCase();
            const password = String(credentials?.password ?? "");
            if (!adminEmail || !adminPassword) return null;
            if (!safeEqual(email, adminEmail) || !safeEqual(password, adminPassword)) {
              return null;
            }
            const user = await prisma.user.upsert({
              where: { email: adminEmail },
              update: {},
              create: { email: adminEmail, emailVerified: new Date() },
            });
            await ensureWorkspaceForUser(user.id, user.email);
            return { id: user.id, email: user.email };
          },
        }),
      ]
    : [
        smtpServer
          ? Nodemailer({ server: smtpServer, from: emailFrom })
          : Resend({
              apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
              from: emailFrom,
            }),
      ],
  callbacks: {
    // Runs before the magic link is sent, so a blocked address never receives
    // one, and again when the link is verified.
    async signIn({ user }) {
      return isEmailAllowedToSignIn(user?.email);
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, user, token }) {
      if (session.user) {
        session.user.id = user?.id ?? (token?.sub as string);
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: PASSWORD_LOGIN ? "jwt" : "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
