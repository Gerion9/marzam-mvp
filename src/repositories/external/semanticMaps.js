const POI_FIELD_CANDIDATES = {
  id: ['id', 'id_pois', 'poi_id', 'point_id', 'uuid_unificado', 'uuid', 'external_code'],
  name: ['name', 'nombre', 'poi_name'],
  address: ['address', 'direccion', 'domicilio'],
  municipality: ['municipality', 'municipio', 'city', 'nom_mun'],
  state: ['state', 'estado', 'nom_ent'],
  lat: ['lat', 'latitude', 'latitud'],
  lng: ['lng', 'longitude', 'longitud', 'lon'],
  contactName: ['contact_person', 'contact_name', 'nombre_contacto'],
  contactPhone: ['contact_phone', 'phone', 'telefono'],
  potential: ['order_potential', 'potential_score', 'potencial', 'popularity_score'],
  verificationStatus: ['verification_status', 'status_verificacion'],
  status: ['status', 'poi_status', 'open_closed_status'],
};

const FIELD_SURVEY_CANDIDATES = {
  id: ['id', 'survey_id', 'visit_id', 'id_pois'],
  pharmacyId: ['pharmacy_id', 'point_id', 'poi_id', 'id_farmacia', 'uuid_unificado', 'id_poi'],
  repId: ['rep_id', 'assigned_rep_id', 'user_id', 'id_usuario'],
  repName: ['rep_name', 'user_name', 'full_name', 'nombre_repartidor'],
  assignmentId: ['assignment_id', 'assignment_key', 'assignment_uuid'],
  waveId: ['wave_id', 'assignment_batch_id', 'session_id', 'campaign_id'],
  campaignObjective: ['campaign_objective', 'objective', 'objetivo'],
  assignmentStatus: ['assignment_status', 'status_asignacion'],
  visitStatus: ['visit_status', 'status_visita', 'visit_result'],
  regularizationStatus: ['regularization_status', 'status_regularizacion'],
  priority: ['priority', 'prioridad'],
  routeOrder: ['route_order', 'orden_ruta', 'route_index'],
  assignedAt: ['assigned_at', 'assignment_timestamp', 'fecha_asignacion', 'created_at'],
  dueAt: ['due_at', 'due_date', 'fecha_compromiso'],
  visitedAt: ['visited_at', 'verified_at', 'verificado_at', 'updated_at'],
  checkinLat: ['checkin_lat', 'lat_gps', 'latitud_gps'],
  checkinLng: ['checkin_lng', 'lng_gps', 'longitud_gps'],
  distanceMeters: ['distance_to_pharmacy_m', 'distance_meters', 'distancia_metros'],
  photoUrl: ['photo_url', 'url'],
  comment: ['comment', 'comentario', 'notes', 'nota'],
  contactName: ['contact_name', 'contact_person', 'nombre_contacto'],
  contactPhone: ['contact_phone', 'phone', 'telefono_contacto'],
  orderPotential: ['order_potential', 'potential_sales', 'potencial_venta'],
  createdBy: ['created_by', 'created_by_user', 'created_by_id'],
};

const DEVICE_LOCATION_CANDIDATES = {
  repId: ['rep_id', 'device_id', 'user_id', 'id_usuario'],
  repName: ['rep_name_snapshot', 'device_name', 'user_name', 'rep_name', 'nombre'],
  assignmentId: ['assignment_id', 'wave_id', 'session_id'],
  verificationId: ['verification_id', 'point_id', 'pharmacy_id'],
  lat: ['lat', 'latitude', 'latitud'],
  lng: ['lng', 'longitude', 'longitud', 'lon'],
  accuracy: ['accuracy_meters', 'accuracy', 'precision_meters'],
  recordedAt: ['recorded_at', 'timestamp', 'created_at', 'tracked_at'],
};

module.exports = {
  POI_FIELD_CANDIDATES,
  FIELD_SURVEY_CANDIDATES,
  DEVICE_LOCATION_CANDIDATES,
};
