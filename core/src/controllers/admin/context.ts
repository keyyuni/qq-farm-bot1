import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminSession {
    id?: string;
    username: string;
    role: string;
    accountLimit: number;
    subscription: any;
    card?: any;
    mustChangePassword?: boolean;
    createdAt: number;
}

export interface AdminContext {
    tokens: Set<string>;
    /** token -> 登录用户会话（多用户体系） */
    sessions: Map<string, AdminSession>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = new Set<string>();
    const sessions = new Map<string, AdminSession>();
    return {
        tokens,
        sessions,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
