import { GameState, Language, Level } from "@nodepolus/framework/src/types/enums";
import { LobbyInstance } from "@nodepolus/framework/src/api/lobby";
import { BasePlugin } from "@nodepolus/framework/src/api/plugin";
import childProcess from "child_process";
import { readFileSync } from "fs";
import Redis from "ioredis";
import os from "os";

const isInDocker = (): boolean => {
  const platform = os.platform();

  if (platform === "darwin" || platform === "win32") {
    return false;
  }

  const file = readFileSync("/proc/self/cgroup", "utf-8");

  return file.indexOf("/docker") !== -1;
};

type LoadPolusConfig = {
  nodeName?: string;
  publicIp?: string;
  redis?: Redis.RedisOptions;
};

export default class extends BasePlugin<LoadPolusConfig> {
  private readonly redis: Redis.Redis;
  private publicIp?: string;

  constructor(config: LoadPolusConfig) {
    super({
      name: "LoadPolus",
      version: [1, 0, 0],
    }, undefined, config);

    const redisPort = parseInt(process.env.NP_REDIS_PORT ?? "", 10);

    config.redis ??= {};
    config.redis.host = process.env.NP_REDIS_HOST?.trim() ?? config.redis.host ?? "127.0.0.1";
    config.redis.port = Number.isInteger(redisPort) ? redisPort : config.redis.port ?? 6379;
    config.redis.password = process.env.NP_REDIS_PASSWORD?.trim() ?? undefined;

    this.setPublicIp();

    if (config.redis.host.startsWith("rediss://")) {
      config.redis.host = config.redis.host.substr("rediss://".length);
      config.redis.tls = {};
      config.redis.connectTimeout = 30000;
    }

    this.redis = new Redis(config.redis);

    this.server.on("server.lobby.created", event => {
      const lobby = event.getLobby();
      const options = lobby.getOptions();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        host: this.publicIp ?? this.server.getDefaultLobbyAddress(),
        port: this.server.getDefaultLobbyPort(),
        level: Level[options.getLevels()[0]],
        impostorCount: options.getImpostorCount(),
        language: Language[options.getLanguages()[0]],
        currentPlayers: 0,
        maxPlayers: options.getMaxPlayers(),
        gameState: GameState[lobby.getGameState()],
        gamemode: lobby.getMeta<string>("gamemode"),
        "public": lobby.isPublic() ? "true" : "false",
      });

      this.redis.sadd(`loadpolus.node.${this.getNodeName()}.lobbies`, lobby.getCode());
    });

    this.server.on("server.lobby.destroyed", event => {
      const code = event.getLobby().getCode();

      this.redis.del(`loadpolus.lobby.${code}`);
      this.redis.srem(`loadpolus.node.${this.getNodeName()}.lobbies`, code);
    });

    this.server.on("player.joined", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.left", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.kicked", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.banned", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("server.lobby.list", event => { event.cancel() });
    this.server.on("game.started", event => this.updateGameState(event.getGame().getLobby()));
    this.server.on("game.ended", event => this.updateGameState(event.getGame().getLobby()));

    this.server.on("lobby.privacy.updated", event => {
      this.redis.hmset(`loadpolus.lobby.${event.getLobby().getCode()}`, {
        "public": event.isPublic() ? "true" : "false",
      });
    });
  }

  private updateCurrentPlayers(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      currentPlayers: lobby.getPlayers().length,
      currentConnections: lobby.getConnections().length,
    });

    this.redis.hmset(`loadpolus.node.${this.getNodeName()}`, {
      currentConnections: this.server.getConnections().size,
    });
  }

  private updateGameState(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      gameState: GameState[lobby.getGameState()],
    });
  }

  private getNodeName(): string {
    return this.config?.nodeName ?? os.hostname();
  }

  private setPublicIp(): void {
    childProcess.execFile("/sbin/ip", ["route"], (_error, stdout, _stderr) => {
      let ip: string | undefined;

      if (stdout.length > 0) {
        const output = stdout;
        const match = output.match(/default via ((?:[0-9]{1,3}\.){3}[0-9]{1,3}) dev eth0/);

        if (Array.isArray(match) && match.length >= 2) {
          ip = match[1];
        }
      }

      this.publicIp = process.env.NP_DROPLET_ADDRESS?.trim()
                   ?? this.config?.publicIp
                   ?? (isInDocker() ? ip : undefined);
    });
  }
}
