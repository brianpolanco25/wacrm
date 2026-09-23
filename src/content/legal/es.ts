import { LEGAL_ENTITY as E } from './entity';
import type { LegalCatalogue } from './types';

const who = `${E.legalName}, RNC ${E.rnc} («${E.brand}», «nosotros»)`;

export const es: LegalCatalogue = {
  privacy: {
    title: 'Política de privacidad',
    summary: `Qué datos trata ${E.brand}, para qué, con quién los comparte y cómo ejercer tus derechos.`,
    sections: [
      {
        heading: 'Quiénes somos',
        paragraphs: [
          `${who}, con domicilio en ${E.city}, ${E.country.es}, presta el servicio ${E.brand} en ${E.site}: una plataforma para que las empresas atiendan a sus clientes por WhatsApp. Para cualquier asunto de privacidad escríbenos a ${E.email}.`,
        ],
      },
      {
        heading: 'Dos papeles distintos',
        paragraphs: [
          'Respecto a los datos de las personas que usan el panel (dueños, administradores y agentes de una cuenta), actuamos como responsables del tratamiento.',
          'Respecto a los datos de los clientes finales con los que cada empresa conversa por WhatsApp, la empresa es la responsable y nosotros actuamos como encargados: los tratamos solo para prestarle el servicio y siguiendo sus instrucciones.',
        ],
      },
      {
        heading: 'Datos que tratamos',
        bullets: [
          'Datos de la cuenta: nombre, correo, contraseña cifrada, rol y empresa.',
          'Datos de WhatsApp Business que la empresa conecta: identificadores de la cuenta y del número, y los tokens de acceso, que guardamos cifrados.',
          'Contenido de las conversaciones: mensajes, adjuntos, contactos (nombre, teléfono o identificador de usuario de WhatsApp), etiquetas y notas.',
          'Datos de facturación: plan, estado de la suscripción e identificadores de PayPal. No recibimos ni guardamos números de tarjeta.',
          'Datos técnicos: registros de acceso, dirección IP y uso de la API, para seguridad y para aplicar los límites de cada plan.',
        ],
      },
      {
        heading: 'Para qué los usamos',
        bullets: [
          'Prestar el servicio: enviar y recibir mensajes, mostrar la bandeja, ejecutar automatizaciones y difusiones.',
          'Generar respuestas con inteligencia artificial cuando la empresa activa esa función.',
          'Cobrar la suscripción y aplicar los límites del plan contratado.',
          'Mantener la seguridad del servicio, prevenir abusos y dar soporte.',
          'Cumplir obligaciones legales.',
        ],
        paragraphs: [
          'No vendemos datos personales ni los usamos para publicidad. No usamos el contenido de las conversaciones para entrenar modelos de inteligencia artificial.',
        ],
      },
      {
        heading: 'Con quién los compartimos',
        paragraphs: [
          'Solo con proveedores que necesitamos para prestar el servicio, cada uno limitado a su función:',
        ],
        bullets: [
          'Meta Platforms (API de WhatsApp Business): para enviar y recibir los mensajes.',
          'Supabase: base de datos, autenticación y almacenamiento de archivos.',
          'PayPal: procesamiento de pagos.',
          'OpenAI y Anthropic: solo si la empresa activa las respuestas con IA; reciben el fragmento de conversación necesario para generar la respuesta.',
          'Proveedores de alojamiento del servidor de la aplicación.',
        ],
      },
      {
        heading: 'Datos de las plataformas de Meta',
        paragraphs: [
          'Cuando una empresa conecta su cuenta de WhatsApp Business mediante el registro integrado de Meta, recibimos los permisos que ella autoriza (whatsapp_business_management y whatsapp_business_messaging). Los usamos exclusivamente para gestionar sus números y plantillas y para enviar y recibir sus mensajes. No los usamos con otro fin ni los compartimos con terceros fuera de lo descrito en esta política.',
        ],
      },
      {
        heading: 'Cuánto tiempo los guardamos',
        paragraphs: [
          'Guardamos los datos mientras la cuenta esté activa. Si la empresa cancela y solicita la eliminación, borramos sus datos en un plazo máximo de 30 días, salvo lo que debamos conservar por obligación legal (por ejemplo, registros de facturación).',
        ],
      },
      {
        heading: 'Seguridad',
        paragraphs: [
          'Ciframos en tránsito todas las comunicaciones y guardamos cifrados los tokens de WhatsApp. El acceso a los datos de cada empresa está aislado por cuenta, y dentro de ella por el rol de cada usuario.',
        ],
      },
      {
        heading: 'Tus derechos',
        paragraphs: [
          `Puedes pedir acceso, rectificación, eliminación u oposición al tratamiento de tus datos escribiendo a ${E.email}. Si eres cliente final de una empresa que usa ${E.brand}, dirígete primero a esa empresa, que es la responsable de tus datos; si nos escribes a nosotros, le trasladaremos la solicitud.`,
          'Las instrucciones para eliminar datos están en la página «Eliminación de datos».',
        ],
      },
      {
        heading: 'Cambios en esta política',
        paragraphs: [
          'Si cambiamos esta política de forma relevante lo avisaremos en el panel o por correo antes de que el cambio entre en vigor.',
        ],
      },
    ],
  },

  terms: {
    title: 'Términos del servicio',
    summary: `Condiciones de uso de ${E.brand}.`,
    sections: [
      {
        heading: 'Aceptación',
        paragraphs: [
          `Estos términos regulan el uso de ${E.brand}, servicio prestado por ${E.legalName} en ${E.site}. Al crear una cuenta o usar el servicio los aceptas en nombre propio y de la empresa que representas.`,
        ],
      },
      {
        heading: 'El servicio',
        paragraphs: [
          `${E.brand} es una plataforma para gestionar conversaciones de WhatsApp Business: bandeja compartida, contactos, automatizaciones, difusiones, respuestas con inteligencia artificial y una API para integraciones. Las funciones y los límites dependen del plan contratado.`,
        ],
      },
      {
        heading: 'Tu cuenta',
        bullets: [
          'Debes dar información veraz y mantener segura tu contraseña y tus claves de API.',
          'Eres responsable de lo que hagan los usuarios que invites a tu cuenta.',
          'Debes tener capacidad legal para contratar en nombre de tu empresa.',
        ],
      },
      {
        heading: 'Uso de WhatsApp',
        paragraphs: [
          'Para usar el servicio necesitas una cuenta de WhatsApp Business propia. Al usarla a través de nosotros te comprometes a cumplir las Condiciones de WhatsApp Business, la Política de Mensajería de WhatsApp Business y las políticas de comercio de Meta.',
        ],
        bullets: [
          'Solo puedes escribir a personas que hayan dado su consentimiento para recibir tus mensajes.',
          'No puedes enviar spam, contenido ilegal, engañoso o que infrinja derechos de terceros.',
          'Meta cobra directamente a tu cuenta de WhatsApp Business las conversaciones según su tarifa; ese cargo es independiente de tu suscripción.',
          'Meta puede limitar o suspender tu número por incumplir sus políticas; eso escapa a nuestro control.',
        ],
      },
      {
        heading: 'Planes, pagos y cancelación',
        bullets: [
          'La suscripción se cobra por adelantado, mensual o anualmente, a través de PayPal, al precio publicado en el panel.',
          'Puedes cancelar cuando quieras desde Ajustes → Suscripción; la cancelación surte efecto al final del periodo ya pagado.',
          'No hacemos reembolsos por periodos parciales salvo que la ley lo exija.',
          'Si un pago falla, la cuenta puede pasar a solo lectura hasta que se regularice.',
        ],
      },
      {
        heading: 'Tus datos',
        paragraphs: [
          'Los datos que subes y las conversaciones con tus clientes son tuyos. Los tratamos para prestarte el servicio según nuestra Política de privacidad. Puedes exportarlos desde el panel o la API mientras la cuenta esté activa.',
        ],
      },
      {
        heading: 'Uso prohibido',
        bullets: [
          'Intentar acceder a datos de otras cuentas o eludir los límites y medidas de seguridad.',
          'Usar el servicio para actividades ilegales o para enviar comunicaciones no solicitadas.',
          'Revender el servicio sin un acuerdo por escrito con nosotros.',
        ],
      },
      {
        heading: 'Disponibilidad y responsabilidad',
        paragraphs: [
          'Trabajamos para que el servicio esté disponible de forma continua, pero se presta «tal cual», sin garantía de funcionamiento ininterrumpido. Dependemos de servicios de terceros (Meta, PayPal, proveedores de alojamiento e IA) cuyas caídas no controlamos.',
          'En la medida en que la ley lo permita, nuestra responsabilidad total frente a ti se limita a lo que hayas pagado por el servicio en los 12 meses anteriores al hecho que la origine.',
        ],
      },
      {
        heading: 'Suspensión y terminación',
        paragraphs: [
          'Podemos suspender o cerrar una cuenta que incumpla estos términos o las políticas de Meta. Tú puedes cerrar tu cuenta en cualquier momento siguiendo las instrucciones de «Eliminación de datos».',
        ],
      },
      {
        heading: 'Cambios y ley aplicable',
        paragraphs: [
          `Podemos actualizar estos términos; te avisaremos de los cambios relevantes con antelación. Se rigen por las leyes de la ${E.country.es}.`,
          `Contacto: ${E.email}.`,
        ],
      },
    ],
  },

  'data-deletion': {
    title: 'Eliminación de datos',
    summary: `Cómo eliminar tus datos de ${E.brand}.`,
    sections: [
      {
        heading: 'Si tienes una cuenta en Cabbity CRM',
        paragraphs: [
          'Puedes borrar contactos y conversaciones concretas desde el panel. Para eliminar la cuenta completa y todos sus datos:',
        ],
        bullets: [
          'Cancela la suscripción en Ajustes → Suscripción, si tienes una activa.',
          `Escribe a ${E.email} desde el correo del dueño de la cuenta con el asunto «Eliminar cuenta».`,
          'Confirmaremos la solicitud y eliminaremos los datos en un plazo máximo de 30 días, salvo lo que debamos conservar por obligación legal.',
        ],
      },
      {
        heading: 'Si conectaste tu cuenta con Facebook',
        paragraphs: [
          'Puedes quitar el acceso de Cabbity desde Facebook en Configuración → Integraciones empresariales, o desde Meta Business Suite en Configuración → Integraciones → Aplicaciones conectadas. Al retirarlo dejamos de poder enviar y recibir mensajes con tu número. Para borrar además los datos que ya guardamos, sigue los pasos del apartado anterior.',
        ],
      },
      {
        heading: 'Si eres cliente final de una empresa',
        paragraphs: [
          `Si conversaste por WhatsApp con una empresa que usa ${E.brand}, esa empresa es la responsable de tus datos: pídele a ella que los elimine. También puedes escribirnos a ${E.email} indicando el número y la empresa, y le trasladaremos la solicitud.`,
        ],
      },
    ],
  },
};
