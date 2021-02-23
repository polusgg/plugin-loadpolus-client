import { BasePlugin } from "../../../lib/api/plugin";
import { Server } from "../../../lib/server";
import Redis from "ioredis";
import { GameState, Language, Level } from "../../../lib/types/enums";
import { LobbyInstance } from "../../../lib/api/lobby";

declare const server: Server;

export default class extends BasePlugin {
  private readonly redis: Redis.Redis;
  private readonly config: Record<any, any>;
  /*private readonly gamemodeReservedCodes: Map<string, string> = new Map([
    ["[]00", "foo"],
    ["[]02", "bar"],
  ]);*/

  constructor() {
    super(server, {
      name: "LoadPolus",
      version: [4, 2, 0],
    });

    this.redis = new Redis({
      port: 6379,
      host: "127.0.0.1",
    });

    // public ip and port used by this node
    this.config = {
      "name": "local",
    }

    server.on("server.lobby.created", event => {
      const lobby = event.getLobby();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        "host": server.getDefaultLobbyAddress(),
        "port": server.getDefaultLobbyPort(),
        "level": Level[lobby.getOptions().getLevels()[0]],
        "impostorCount": lobby.getOptions().getImpostorCount(),
        "language": Language[lobby.getOptions().getLanguages()[0]],
        "currentPlayers": 0,
        "maxPlayers": lobby.getOptions().getMaxPlayers(),
        "gameState": GameState[lobby.getGameState()],
        "gamemode": lobby.getMeta<string>("gamemode"),
        "public": lobby.isPublic() ? "true" : "false",
      });

      this.redis.sadd(`loadpolus.node.${this.config.name}.lobbies`, lobby.getCode());
    });

    server.on("server.lobby.destroyed", event => {
      const lobby = event.getLobby();
      
      this.redis.del(`loadpolus.lobby.${lobby.getCode()}`);
      this.redis.srem(`loadpolus.node.${this.config.name}.lobbies`, lobby.getCode());
    });

    server.on("player.joined", event => {
      const lobby = event.getLobby();
      this.updateCurrentPlayers(lobby);
    });

    server.on("player.left", event => {
      const lobby = event.getLobby();
      this.updateCurrentPlayers(lobby);
    });

    server.on("player.kicked", event => {
      const lobby = event.getLobby();
      this.updateCurrentPlayers(lobby);
    });

    server.on("player.banned", event => {
      const lobby = event.getLobby();
      this.updateCurrentPlayers(lobby);
    });

    server.on("server.lobby.list", event => event.cancel());

    server.on("lobby.privacy.updated", event => {
      const newValue = event.isPublic() ? "true" : "false";

      this.redis.hmset(`loadpolus.lobby.${event.getLobby().getCode()}`, {
        "public": newValue,
      })
    })
  }

  private updateCurrentPlayers(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      "currentPlayers": lobby.getPlayers().length,
      "currentConnections": lobby.getConnections().length,
    });

    this.redis.hmset(`loadpolus.node.${this.config.name}`, {
      "currentConnections": server.getConnections().size,
    });
  }

  /*private matchmakingFindLobby(targetGamemode: string) {
    const allGames = server.getLobbies();
    const lobbyCandidates: Lobby[];

    for (let i = 0; i < allGames.length; i++) {
      const currentGame = allGames[i];
      const gamemode = currentGame.getMeta("gamemode");

      if (!currentGame.isPublic()) {
        continue;
      }

      if (currentGame.getGameState() != GameState.NotStarted) {
        continue;
      }
      
      if (gamemode != targetGamemode) {
        continue;
      }

      if (currentGame.getPlayers().length >= currentGame.getSettings().getMaxPlayers()) {
        continue;
      }

      if (currentGame.get)
    }
  }*/
}
