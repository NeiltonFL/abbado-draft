import { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";
import prisma from "../lib/prisma";

// ── Types ──

export interface AuthContext {
  userId: string;
  orgId: string;
  role: string; // admin, editor, user, viewer
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// ── 1. Authentication: Validate JWT, attach user context ──

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = header.slice(7);

    // Validate with Supabase Auth
    const { data: { user: supaUser }, error } = await supabase.auth.getUser(token);
    if (error || !supaUser) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Look up user in our database
    const user = await prisma.user.findUnique({
      where: { authId: supaUser.id },
    });

    if (!user || !user.isActive) {
      return res.status(403).json({ error: "User not found or deactivated" });
    }

    // Attach auth context to request
    req.auth = {
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "Authentication failed" });
  }
}

// ── 2. Authorization: Check role against required minimum ──

const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  user: 1,
  editor: 2,
  admin: 3,
};

export function requireRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const userLevel = ROLE_HIERARCHY[req.auth.role] ?? -1;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 99;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: "Insufficient permissions",
        required: minRole,
        current: req.auth.role,
      });
    }

    next();
  };
}

// ── 3. Tenant Scoping: Get org-scoped query filter ──

export function getScope(req: Request): { orgId: string } {
  if (!req.auth) {
    throw new Error("getScope called without auth context");
  }
  return { orgId: req.auth.orgId };
}

// ── 4. Audit Logging: Log significant actions ──

export async function auditLog(
  orgId: string,
  userId: string | null,
  action: string,
  resourceType?: string,
  resourceId?: string,
  details?: any,
  ipAddress?: string
) {
  try {
    await prisma.auditLogEntry.create({
      data: {
        orgId,
        userId,
        action,
        resourceType,
        resourceId,
        details,
        ipAddress,
      },
    });
  } catch (err) {
    // Audit logging should never break the request
    console.error("Audit log error:", err);
  }
}

// ── 5. Audit Middleware: Auto-log every mutating request ──

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only log mutating requests
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.auth) {
    const ip = req.headers["x-forwarded-for"]?.toString() || req.socket.remoteAddress || "";

    // Log after the response is sent (don't block the request)
    res.on("finish", () => {
      if (req.auth) {
        auditLog(
          req.auth.orgId,
          req.auth.userId,
          `${req.method} ${req.path}`,
          undefined,
          undefined,
          { statusCode: res.statusCode },
          ip
        );
      }
    });
  }

  next();
}
