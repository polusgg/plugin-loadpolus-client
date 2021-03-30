import { GameState, Language, Level } from "@nodepolus/framework/src/types/enums";
import { LobbyInstance } from "@nodepolus/framework/src/api/lobby";
import { BasePlugin } from "@nodepolus/framework/src/api/plugin";
import { AllRequired } from "@nodepolus/framework/src/types";
import Redis from "ioredis";
import os from "os";

type LoadPolusConfig = {
  nodeName: string;
  redis: {
    host: string,
    port: number,
  }
};

const defaultConfig: Readonly<AllRequired<LoadPolusConfig>> = {
  nodeName: os.hostname(),
  redis: {
    port: 6379,
    host: "127.0.0.1",
  },
};

export default class extends BasePlugin<LoadPolusConfig> {
  private readonly redis: Redis.Redis;

  constructor(config: LoadPolusConfig) {
    super({
      name: "LoadPolus",
      version: [1, 0, 0],
    }, defaultConfig, config);

    this.redis = new Redis({
      host: this.getRedisHost(),
      port: this.getRedisPort(),
    });

    this.server.on("server.lobby.created", event => {
      const lobby = event.getLobby();
      const options = lobby.getOptions();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        host: this.server.getDefaultLobbyAddress(),
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
    return this.config?.nodeName ?? defaultConfig.nodeName;
  }

  private getRedisHost(): string {
    return this.config?.redis?.host ?? defaultConfig.redis.host;
  }

  private getRedisPort(): number {
    return this.config?.redis?.port ?? defaultConfig.redis.port;
  }
}
