import { GameState, Language, Level } from "nodepolus/lib/types/enums";
import { LobbyInstance } from "nodepolus/lib/api/lobby";
import { BasePlugin } from "nodepolus/lib/api/plugin";
import { Server } from "nodepolus/lib/server";
import Redis from "ioredis";

declare const server: Server;

type Config = {
  name: string;
};

export default class extends BasePlugin {
  private readonly redis: Redis.Redis;
  private readonly config: Config;

  constructor() {
    super(server, {
      name: "LoadPolus",
      version: [1, 0, 0],
    });

    this.redis = new Redis({
      port: 6379,
      host: "127.0.0.1",
    });

    this.config = {
      name: "local",
    };

    server.on("server.lobby.created", event => {
      const lobby = event.getLobby();
      const options = lobby.getOptions();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        host: server.getDefaultLobbyAddress(),
        port: server.getDefaultLobbyPort(),
        level: Level[options.getLevels()[0]],
        impostorCount: options.getImpostorCount(),
        language: Language[options.getLanguages()[0]],
        currentPlayers: 0,
        maxPlayers: options.getMaxPlayers(),
        gameState: GameState[lobby.getGameState()],
        gamemode: lobby.getMeta<string>("gamemode"),
        "public": lobby.isPublic() ? "true" : "false",
      });

      this.redis.sadd(`loadpolus.node.${this.config.name}.lobbies`, lobby.getCode());
    });

    server.on("server.lobby.destroyed", event => {
      const code = event.getLobby().getCode();

      this.redis.del(`loadpolus.lobby.${code}`);
      this.redis.srem(`loadpolus.node.${this.config.name}.lobbies`, code);
    });

    server.on("player.joined", event => this.updateCurrentPlayers(event.getLobby()));
    server.on("player.left", event => this.updateCurrentPlayers(event.getLobby()));
    server.on("player.kicked", event => this.updateCurrentPlayers(event.getLobby()));
    server.on("player.banned", event => this.updateCurrentPlayers(event.getLobby()));
    server.on("server.lobby.list", event => event.cancel());
    server.on("game.started", event => this.updateGameState(event.getGame().getLobby()));
    server.on("game.ended", event => this.updateGameState(event.getGame().getLobby()));

    server.on("lobby.privacy.updated", event => {
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

    this.redis.hmset(`loadpolus.node.${this.config.name}`, {
      currentConnections: server.getConnections().size,
    });
  }

  private updateGameState(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      gameState: GameState[lobby.getGameState()],
    });
  }
}
