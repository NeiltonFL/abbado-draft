import { Router } from "express";
import prisma from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { authenticate, auditLog } from "../middleware/auth";

export const authRoutes = Router();

// ── Register: Create organization + first admin user ──
// This is the entry point for new customers
authRoutes.post("/register", async (req, res) => {
  try {
    const { email, password, name, orgName } = req.body;

    if (!email || !password || !name || !orgName) {
      return res.status(400).json({
        error: "email, password, name, and orgName are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // 1. Create Supabase Auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for registration
      user_metadata: { name },
    });

    if (authError) {
      // Check for duplicate email
      if (authError.message.includes("already been registered")) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      return res.status(400).json({ error: `Auth error: ${authError.message}` });
    }

    // 2. Create organization
    const slug = orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Check for duplicate slug
    const existingOrg = await prisma.organization.findUnique({ where: { slug } });
    const finalSlug = existingOrg ? `${slug}-${Date.now().toString(36)}` : slug;

    const org = await prisma.organization.create({
      data: {
        name: orgName,
        slug: finalSlug,
        plan: "free",
        settings: { defaultDocMode: "live", autoOpenAddin: true },
      },
    });

    // 3. Create admin user record linked to Supabase Auth
    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        authId: authData.user.id,
        name,
        email,
        role: "admin",
      },
    });

    // 4. Create default local storage adapter
    await prisma.storageAdapter.create({
      data: {
        orgId: org.id,
        adapterType: "local",
        name: "Abbado Draft Storage",
        isDefault: true,
        healthStatus: "healthy",
        lastHealthCheck: new Date(),
        config: { bucket: "draft-documents" },
      },
    });

    // 5. Log it
    await auditLog(org.id, user.id, "org.created", "organization", org.id, {
      orgName,
      adminEmail: email,
    });

    await prisma.activityEntry.create({
      data: {
        orgId: org.id,
        activityType: "org.created",
        actorId: user.id,
        summary: `Organization "${orgName}" created by ${name}`,
      },
    });

    res.status(201).json({
      message: "Registration successful. You can now sign in.",
      org: { id: org.id, name: org.name, slug: org.slug },
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err: any) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync: Ensure database user exists for authenticated Supabase user ──
// Called after login to create/update the DB user record if needed
authRoutes.post("/sync", authenticate, async (req, res) => {
  try {
    const authId = req.auth!.userId; // This is actually the DB user ID from auth middleware

    // User already exists and was found by auth middleware — just return current state
    res.json({
      user: {
        id: req.auth!.userId,
        orgId: req.auth!.orgId,
        name: req.auth!.name,
        email: req.auth!.email,
        role: req.auth!.role,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Me: Get current user info ──
authRoutes.get("/me", authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      include: {
        org: { select: { id: true, name: true, slug: true, plan: true } },
      },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      org: user.org,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Accept invite: Link Supabase Auth user to existing DB record ──
// Called when an invited user signs in for the first time
authRoutes.post("/accept-invite", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    // Validate the token with Supabase
    const { data: { user: supaUser }, error } = await supabase.auth.getUser(token);
    if (error || !supaUser) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Find the DB user record created during invite (matched by email)
    const dbUser = await prisma.user.findFirst({
      where: {
        email: supaUser.email!,
        authId: supaUser.id, // Should already be set during invite
      },
    });

    if (!dbUser) {
      // Try finding by email only (authId might not be set yet)
      const byEmail = await prisma.user.findFirst({
        where: { email: supaUser.email! },
      });

      if (byEmail && !byEmail.authId.startsWith("auth-placeholder")) {
        // Already linked
        return res.json({ user: byEmail, message: "Already linked" });
      }

      if (byEmail) {
        // Link the Supabase Auth ID to the existing DB record
        const updated = await prisma.user.update({
          where: { id: byEmail.id },
          data: { authId: supaUser.id },
        });
        return res.json({ user: updated, message: "Account linked successfully" });
      }

      return res.status(404).json({ error: "No invitation found for this email" });
    }

    res.json({ user: dbUser, message: "Account ready" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
