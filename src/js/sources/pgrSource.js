'use strict';

const Source = require('./source');
const { Client } = require('pg');
const fs = require('fs');
const RouteResponse = require('../responses/routeResponse');
const Route = require('../responses/route');
const Portion = require('../responses/portion');
const Step = require('../responses/step');
const errorManager = require('../utils/errorManager');
const log4js = require('log4js');

// Création du LOGGER
const LOGGER = log4js.getLogger("PGRSOURCE");

/**
*
* @class
* @name pgrSource
* @description Classe modélisant une source pgRouting.
*
*/
module.exports = class pgrSource extends Source {
  /**
  *
  * @function
  * @name constructor
  * @description Constructeur de la classe pgrSource
  *
  */
  constructor(sourceJsonObject) {
    // Constructeur parent
    super(sourceJsonObject.id,sourceJsonObject.type);
    // Stockage de la configuration
    this._configuration = sourceJsonObject;
    // Client de base de données
    let db_config_path = this._configuration.storage.db_config;
    let raw_config = fs.readFileSync(db_config_path);
    this._db_config = JSON.parse(raw_config);

    this._client = new Client(this._db_config);
  }

  /**
  *
  * @function
  * @name get configuration
  * @description Récupérer la configuration de la source
  *
  */
  get configuration () {
    return this._configuration;
  }

  /**
  *
  * @function
  * @name set configuration
  * @description Attribuer la configuration de la source
  *
  */
  set configuration (conf) {
    this._configuration = conf;
  }

  /**
  *
  * @function
  * @name connect
  * @description Connection à la base pgRouting
  * @return {boolean} vrai si tout c'est bien passé et faux s'il y a eu une erreur
  *
  */
  async connect() {
    // Connection à la base de données
    LOGGER.info("Connection à la base de données : " + this._db_config.database);
    try {
      const err = await this._client.connect();
      if (err) {
        LOGGER.error('connection error', err.stack)
        return false;
      }
    } catch (err) {
      LOGGER.error('connection error', err.stack)
      return false;
    }
    LOGGER.info("Connecté à la base de données : " + this._db_config.database);
    super.connected = true;
    return true;
  }

  /**
  *
  * @function
  * @name disconnect
  * @description Déconnection à la base pgRouting
  * @return {boolean} vrai si tout c'est bien passé et faux s'il y a eu une erreur
  *
  */
  async disconnect() {
    const err = await this._client.end();
    if (err) {
      LOGGER.error('connection error', err.stack)
      return false;
    }
    LOGGER.info("Connecté à la base : " + this._db_config.database);
    super.connected = true;
    return true;
  }

  /**
  *
  * @function
  * @name computeRequest
  * @description Traiter une requête.
  * Ce traitement est placé ici car c'est la source qui sait quel moteur est concernée par la requête.
  * @param {Request} request - Objet Request ou dérivant de la classe Request
  *
  */
  computeRequest (request) {

    if (request.operation === "route") {

      // Construction de l'objet pour la requête pgr
      // Cette construction dépend du type de la requête fournie
      // ---
      let pgrRequest = {};
      let sql_function;

      if (request.type === "routeRequest") {
        // Coordonnées
        const coordinatesTable = new Array();
        // start
        coordinatesTable.push([request.start.lon, request.start.lat]);
        // intermediates
        if (request.intermediates.length !== 0) {
          for (let i = 0; i < request.intermediates.length; i++) {
            coordinatesTable.push([request.intermediates[i].lon, request.intermediates[i].lat]);
          }
        }
        // end
        coordinatesTable.push([request.end.lon, request.end.lat]);

        pgrRequest.coordinates = coordinatesTable;

        // steps
        if (request.computeGeometry) {
          sql_function = "coord_dijkstra";
        } else {
          sql_function = "coord_dijkstra_no_geom";
        }

      } else {
        // on va voir si c'est un autre type de requête
      }

      // ---
      const query_string = "SELECT * FROM " + sql_function +
        "($1::double precision, $2::double precision, $3::double precision, $4::double precision,'" +
        this._configuration.storage.costColumn +
        "','" +
        this._configuration.storage.reverseCostColumn +
        "')";

      return new Promise( (resolve, reject) => {
        this._client.query(query_string, pgrRequest, (err, result) => {
          if (err) {
            LOGGER.error(err);
            reject(err);
          } else {
            resolve(this.writeRouteResponse(request, result));
          }
        });
      });

    } else {
      // on va voir si c'est une autre opération
    }

  }

  /**
  *
  * @function
  * @name writeRouteResponse
  * @description Pour traiter la réponse du moteur et la ré-écrire pour le proxy.
  * Ce traitement est placé ici car c'est à la source de renvoyer une réponse adaptée au proxy.
  * C'est cette fonction qui doit vérifier le contenu de la réponse. Une fois la réponse envoyée
  * au proxy, on considère qu'elle est correcte.
  * @param {Request} request - Objet Request ou dérivant de la classe Request
  * @param {pgrResponse} pgrResponse - Objet pgrResponse
  * @param {function} callback - Callback de succès (Objet Response ou dérivant de la classe Response) et d'erreur
  *
  */
  writeRouteResponse (routeRequest, pgrResponse, callback) {

    let resource;
    let start;
    let end;
    let profile;
    let optimization;
    let routes = new Array();

    // Récupération des paramètres de la requête que l'on veut transmettre dans la réponse
    // ---
    // resource
    resource = routeRequest.resource;

    // profile
    profile = routeRequest.profile;

    // optimization
    optimization = routeRequest.optimization;
    // ---

    // Traitement de la réponse PGR
    // ---
    const response = {
      waypoints: [],
      routes: []
    };
    const route_geometry = {
      type: "LineString",
      coordinates: []
    };

    for (let row of pgrResponse) {
      // TODO: Il n'y a qu'une route pour l'instant
      response.routes.push( {geometry: route_geometry, legs: [] } );

      if (row.node_lon) {
        response.waypoints.push( { location: [row.node_lon, row.node_lat] } );
      }
      if (row.geom_json) {
        current_geom = JSON.parse(row.geom_json);
        for (let i = 0; i++; i < current_geom.coordinates.length - 1) {
          route_geometry.coordinates.push( current_geom.coordinates[i] );
        }
      }
      if (row.path_seq === 1) {
        response.routes.legs.push( { steps: [] } );
      }

      response.routes.legs.slice(-1)[0].steps.push( { geometry: JSON.parse(row.geom_json) } )
    }

    if (response.waypoints.length < 2) {
      // Cela veut dire que l'on n'a pas un start et un end dans la réponse OSRM
      throw errorManager.createError(" OSRM response is invalid: the number of waypoints is lower than 2. ");
    }

    // start
    start = response.waypoints[0].location[0] +","+ response.waypoints[0].location[1];

    // end
    end = response.waypoints[response.waypoints.length-1].location[0] +","+ response.waypoints[response.waypoints.length-1].location[1];

    let routeResponse = new RouteResponse(resource, start, end, profile, optimization);

    if (response.routes.length === 0) {
      // Cela veut dire que l'on n'a pas un start et un end dans la réponse OSRM
      throw errorManager.createError(" OSRM response is invalid: the number of routes is equal to 0. ");
    }

    // routes
    // Il peut y avoir plusieurs itinéraires
    for (let i = 0; i < response.routes.length; i++) {

      let portions = new Array();
      let currentPgrRoute = response.routes[i];

      // On commence par créer l'itinéraire avec les attributs obligatoires
      routes[i] = new Route(currentPgrRoute.geometry);

      // On doit avoir une égalité entre ces deux valeurs pour la suite
      // Si ce n'est pas le cas, c'est qu'OSRM n'a pas le comportement attendu...
      if (currentPgrRoute.legs.length !== response.waypoints.length-1) {
        throw errorManager.createError(" OSRM response is invalid: the number of legs is not proportionnal to the number of waypoints. ");
      }

      // On va gérer les portions qui sont des parties de l'itinéraire entre deux points intermédiaires
      for (let j = 0; j < currentPgrRoute.legs.length; j++) {

        let currentPgrRouteLeg = currentPgrRoute.legs[j];
        let legStart = response.waypoints[j].location[0] +","+ response.waypoints[j].location[1];
        let legEnd = response.waypoints[j+1].location[0] +","+ response.waypoints[j+1].location[1];

        portions[j] = new Portion(legStart, legEnd);

        if (routeRequest.computeGeometry) {
          let steps = new Array();

          // On va associer les étapes à la portion concernée
          for (let k=0; k < currentPgrRouteLeg.steps.length; k++) {

            let currentPgrRouteStep = currentPgrRouteLeg.steps[k];
            steps[k] = new Step(currentPgrRouteStep.geometry);
          }

          portions[j].steps = steps;

        } else {
          // Comme la géométrie des steps n'est pas demandée, on ne l'a donne pas
        }

      }

      routes[i].portions = portions;

    }

    routeResponse.routes = routes;

    // ---
    return routeResponse;

  }


}
