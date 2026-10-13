// Record-level access rules shared by the route modules (least privilege on top of role checks).

// Doctors work on visits assigned to them, plus unassigned visits that any doctor may pick up.
function doctorCanAccess(user, assignedDoctorId) {
  return user.role !== 'Doctor' || assignedDoctorId == null || Number(assignedDoctorId) === Number(user.id);
}

// Patients only ever see records linked to their own patient ID.
function patientCanAccess(user, patientId) {
  return user.role !== 'Patient' || Number(user.patient_id) === Number(patientId);
}

module.exports = { doctorCanAccess, patientCanAccess };
